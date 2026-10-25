package com.whale.pet

/**
 * 逐句播报的调度核心：只做「谁该下载、谁该出声、槽位什么时候还」这三件事，
 * 不碰 Android、文件、线程，所以能在 JVM 单测里用假下载器把时序摆开验。
 *
 * 四条约束（都是线上踩出来的）：
 *  1. **出声顺序 = 入队顺序**。下载并行，但只有「最小还活着的句子」可以出声；
 *     后面先下完的必须等，否则第二句先响、第一句补在后面，听起来像答非所问。
 *  2. **同一句话只留一个在途合成**。相同文本+音色的重复请求挂到在途任务下面等结果，
 *     不再各开一个下载——两个任务写同一个落盘文件时，先完成的把临时文件改名拿走，
 *     另一个再去拷贝就抛 NoSuchFileException（而且崩在后台线程，直接闪退）。
 *  3. **槽位必须在 finally 里还**。成功/失败/取消/上一轮迟到的回调，一律先把并发槽位
 *     还回去再决定别的；旧轮的回调尤其不能 `if (old) return` 就完事，否则新一句没人调度，
 *     语音队列就永久卡死（打断后重新说话没声音）。
 *  4. **空闲要以「全部排空」为准**。只看出声标志不行：还在下载/准备时开麦会把自己的
 *     下一句录进去。`busy` 覆盖下载和在途任务，`onIdle` 只在最后一次回调之后发一次。
 */
internal class TtsQueue(private val maxAhead: Int = 2) {

    interface Listener {
        /** 需要真下载一句话；`tempTag` 每次唯一，落临时文件名用它，别用固定 `.part`。 */
        fun onDownload(seq: Long, text: String, preset: String, tempTag: Long)

        /** 轮到这一句出声了（文件已就绪，按 seq 升序回调）。 */
        fun onSpeak(seq: Long, text: String, preset: String, enqueuedAt: Long)

        /** 这一句跳过了（合成/落盘/播放失败），继续后面的句子。 */
        fun onFailed(seq: Long, reason: String)

        /** 从「还有活」变成「彻底没事」的时刻，连续对话据此重新开麦。 */
        fun onIdle()
    }

    private class Task(
        val seq: Long,
        val text: String,
        val preset: String,
        val enqueuedAt: Long,
        val key: String,
        val epoch: Int,
    )

    var listener: Listener? = null

    /** 还没派下载的句子。 */
    private val pending = ArrayDeque<Task>()

    /** 文件已就绪、只等轮到的句子，按 seq 升序。 */
    private val ready = java.util.TreeMap<Long, Task>()

    /** 正在下载：seq -> 任务（占并发槽位）。 */
    private val inflight = LinkedHashMap<Long, Task>()

    /** 同一缓存键的后来者，等领头任务出结果，不再单独下载。 */
    private val waiters = HashMap<String, MutableList<Task>>()

    /** 正在出声的 seq，-1 = 没人在响。 */
    private var playing = -1L

    /** 单调递增，跨轮也不重置：临时文件名和执行顺序都靠它。 */
    private var seqGen = 0L

    /** 打断轮次；旧轮回调据此判废，但槽位照还。 */
    private var epoch = 0

    private var wasBusy = false

    /* ---------------- 对外 ---------------- */

    /**
     * 排一句。`cached` = 落盘文件已经在（播放器自己查），命中就直接进待播队列。
     * 返回这一句的顺序号，便于日志和测试核对。
     */
    fun enqueue(text: String, preset: String, enqueuedAt: Long, cached: Boolean): Long {
        val seq = seqGen++
        val task = Task(seq, text, preset, enqueuedAt, keyOf(text, preset), epoch)
        if (cached) ready[seq] = task else pending.addLast(task)
        pump()
        speakIfTurn()
        return seq
    }

    /**
     * 下载结束（成功/失败都算）。迟到回调也要调用：槽位在这里还，调度也在这里重新发起。
     * 返回 true 表示结果被本轮采用，false 表示这一句属于已被打断的轮次（文件由调用方删）。
     */
    fun onDownloadDone(seq: Long, ok: Boolean, reason: String = ""): Boolean {
        val task = inflight.remove(seq)
        if (task == null) {
            // 已经被取消/失败清掉的任务：仍然还完槽位再调度，绝不让新一句饿死
            pump()
            speakIfTurn()
            return false
        }
        val alive = task.epoch == epoch
        if (alive && ok) {
            ready[task.seq] = task
            waiters.remove(task.key)?.forEach { w -> if (w.epoch == epoch) ready[w.seq] = w }
        } else {
            waiters.remove(task.key)?.forEach { w -> if (w.epoch == epoch) fail(w, reason.ifBlank { "语音合成失败" }) }
            if (alive) fail(task, reason.ifBlank { "语音合成失败" })
        }
        pump()
        speakIfTurn()
        notifyIdle()
        return alive
    }

    /** 一句播完（含被打断/停止）：让出声音，轮到下一句。 */
    fun onPlayDone(seq: Long) {
        if (playing == seq) playing = -1
        speakIfTurn()
        notifyIdle()
    }

    /** 这一句放不出来（文件没了/解码失败）：跳过它，后面的照常。 */
    fun onPlayFailed(seq: Long, reason: String) {
        if (playing == seq) playing = -1
        val task = removeEverywhere(seq)
        if (task != null) listener?.onFailed(seq, reason.ifBlank { "播放失败" })
        speakIfTurn()
        notifyIdle()
    }

    /** 打断：丢掉没出声的句子；在途下载留着，等它们的回调把槽位还回来。 */
    fun stopAll() {
        epoch++
        pending.clear()
        ready.clear()
        waiters.clear()
        playing = -1L
        wasBusy = busy()
        // 本来就没在途下载时，这一刀就是「彻底排空」：该发一次的排空通知不能省，
        // 否则连续对话等不到重开麦的信号
        notifyIdle()
    }

    /** 还有没有活要干：排队、下载中、等出声、正在出声都算。 */
    fun busy(): Boolean =
        playing >= 0L || pending.isNotEmpty() || ready.isNotEmpty() ||
            inflight.isNotEmpty() || waiters.isNotEmpty()

    /** 还在下载的句数：诊断用，也证明 busy 覆盖了「下载中」。 */
    fun downloading(): Int = inflight.size

    /* ---------------- 调度 ---------------- */

    private fun keyOf(text: String, preset: String): String = "$preset\u0000$text"

    /** 填满并发槽位：队头同一句已有在途任务时挂到它下面，不再开新下载。 */
    private fun pump() {
        while (inflight.size < maxAhead && pending.isNotEmpty()) {
            val task = pending.first()
            val duplicate = inflight.values.any { it.key == task.key }
            if (duplicate) {
                pending.removeFirst()
                waiters.getOrPut(task.key) { mutableListOf() }.add(task)
                continue
            }
            pending.removeFirst()
            inflight[task.seq] = task
            listener?.onDownload(task.seq, task.text, task.preset, task.seq)
        }
    }

    /** 只有「序号最小的那一句」能出声，且同一时刻只出声一句。 */
    private fun speakIfTurn() {
        while (playing < 0L) {
            val head = headSeq()
            if (head < 0L) break
            val task = ready[head] ?: break
            ready.remove(head)
            playing = task.seq
            listener?.onSpeak(task.seq, task.text, task.preset, task.enqueuedAt)
        }
        notifyIdle()
    }

    private fun headSeq(): Long {
        var min = Long.MAX_VALUE
        for (s in ready.keys) min = minOf(min, s)
        for (s in inflight.keys) min = minOf(min, s)
        for (list in waiters.values) for (t in list) min = minOf(min, t.seq)
        for (t in pending) min = minOf(min, t.seq)
        return if (min == Long.MAX_VALUE) -1L else min
    }

    private fun fail(task: Task, reason: String) {
        if (playing == task.seq) playing = -1L
        removeEverywhere(task.seq)
        listener?.onFailed(task.seq, reason)
    }

    private fun removeEverywhere(seq: Long): Task? {
        ready.remove(seq)?.let { return it }
        inflight.remove(seq)?.let { return it }
        pending.firstOrNull { it.seq == seq }?.let { pending.remove(it); return it }
        val it = waiters.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.seq == seq } }
        if (it != null) {
            waiters.values.forEach { list -> list.removeAll { t -> t.seq == seq } }
            waiters.entries.removeAll { it.value.isEmpty() }
            return it
        }
        return null
    }

    /** 从「还有活」变成「彻底没事」时通知一次，别在还有下载时就喊空闲。 */
    private fun notifyIdle() {
        val b = busy()
        if (wasBusy && !b) listener?.onIdle()
        wasBusy = b
    }
}
