package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [TtsQueue] 的时序单测：用假下载器把「谁先下完、谁该出声、槽位什么时候还」摆开验。
 *
 * 覆盖四个线上问题：乱序播放、同句并发合成、打断后槽位不释放、busy 漏掉下载中。
 */
class TtsQueueTest {

    /** 假播放器：记录下载请求和出声顺序，不碰文件/线程。 */
    private class Recorder : TtsQueue.Listener {
        val downloads = mutableListOf<Pair<Long, String>>()
        val speaks = mutableListOf<Long>()
        val failed = mutableListOf<Pair<Long, String>>()
        var idleCount = 0

        override fun onDownload(seq: Long, text: String, preset: String, tempTag: Long) {
            downloads += seq to text
        }

        override fun onSpeak(seq: Long, text: String, preset: String, enqueuedAt: Long) {
            speaks += seq
        }

        override fun onFailed(seq: Long, reason: String) {
            failed += seq to reason
        }

        override fun onIdle() {
            idleCount++
        }
    }

    private fun queue(r: Recorder, maxAhead: Int = 2): TtsQueue =
        TtsQueue(maxAhead).also { it.listener = r }

    /** 下载是并行的，出声必须严格按入队顺序：第二句先下完也得等第一句。 */
    @Test
    fun playbackFollowsEnqueueOrderEvenWhenLaterDownloadFinishesFirst() {
        val r = Recorder()
        val q = queue(r)
        val a = q.enqueue("第一句。", "p", 1L, cached = false)
        val b = q.enqueue("第二句。", "p", 2L, cached = false)
        assertEquals(listOf(a to "第一句。", b to "第二句。"), r.downloads)

        // 第二句先下完：不许出声
        assertTrue(q.onDownloadDone(b, ok = true))
        assertTrue(r.speaks.isEmpty())
        assertEquals(1, q.downloading()) // 第二句的槽位已还，只剩第一句在途
        // 第一句下完才轮到它，然后第二句紧接
        assertTrue(q.onDownloadDone(a, ok = true))
        assertEquals(listOf(a), r.speaks)
        q.onPlayDone(a)
        assertEquals(listOf(a, b), r.speaks)
    }

    /** 同一句话并发排两次：只下载一次，两个请求都按时出声，不会各写一个临时文件。 */
    @Test
    fun identicalTextWhileInFlightDownloadsOnce() {
        val r = Recorder()
        val q = queue(r)
        val a = q.enqueue("同一句。", "p", 1L, cached = false)
        val b = q.enqueue("同一句。", "p", 2L, cached = false)
        assertEquals(1, r.downloads.size)
        assertEquals(a, r.downloads[0].first)

        assertTrue(q.onDownloadDone(a, ok = true))
        q.onPlayDone(a)
        assertEquals(listOf(a, b), r.speaks)
    }

    /**
     * 打断后旧下载的回调必须还槽位并重新调度：以前旧轮回调直接 return，
     * 槽位被旧任务永久占着，新的一句话再也没人下载，语音就哑了。
     */
    @Test
    fun staleDownloadCompletionReleasesSlotAndSchedulesNewTurn() {
        val r = Recorder()
        val q = queue(r, maxAhead = 1)
        q.enqueue("旧一句。", "p", 1L, cached = false)
        assertEquals(1, r.downloads.size)

        q.stopAll()
        val fresh = q.enqueue("新一句。", "p", 2L, cached = false)
        // 槽位还被旧轮占着，新句只能排队
        assertEquals(1, r.downloads.size)
        assertTrue(q.busy())

        // 旧轮迟到回调：不算本轮，但槽位必须还，新句马上下载
        assertFalse(q.onDownloadDone(r.downloads[0].first, ok = false))
        assertEquals(2, r.downloads.size)
        assertEquals(fresh, r.downloads[1].first)
        assertTrue(q.onDownloadDone(fresh, ok = true))
        assertEquals(listOf(fresh), r.speaks)
    }

    /** busy 要把「还在下载」算进去：只看出声标志会在句间缝隙里误报空闲。 */
    @Test
    fun busyCoversDownloadingAndClearsOnlyAfterPlayback() {
        val r = Recorder()
        val q = queue(r)
        assertFalse(q.busy())
        val a = q.enqueue("一句。", "p", 1L, cached = false)
        assertTrue(q.busy())
        assertEquals(1, q.downloading())
        assertTrue(q.onDownloadDone(a, ok = true))
        assertTrue(q.busy()) // 已就绪但还没播完
        assertEquals(0, q.downloading())
        q.onPlayDone(a)
        assertFalse(q.busy())
        assertEquals(1, r.idleCount)
    }

    /** 缓存命中不下载；播放严格串行，播完一句才起下一句。 */
    @Test
    fun cachedSentencesPlayInOrderWithoutDownload() {
        val r = Recorder()
        val q = queue(r)
        val a = q.enqueue("甲。", "p", 1L, cached = true)
        val b = q.enqueue("乙。", "p", 2L, cached = true)
        val c = q.enqueue("丙。", "p", 3L, cached = true)
        assertTrue(r.downloads.isEmpty())
        assertEquals(listOf(a), r.speaks)
        q.onPlayDone(a)
        assertEquals(listOf(a, b), r.speaks)
        q.onPlayDone(b)
        assertEquals(listOf(a, b, c), r.speaks)
        q.onPlayDone(c)
        assertFalse(q.busy())
    }

    /** 某一句失败只跳过它，后面的照常出声，不能把整条队列卡死。 */
    @Test
    fun failedSentenceIsSkippedAndRestKeepsGoing() {
        val r = Recorder()
        val q = queue(r)
        val a = q.enqueue("坏句。", "p", 1L, cached = false)
        val b = q.enqueue("好句。", "p", 2L, cached = false)
        q.onDownloadDone(a, ok = false, reason = "合成结果为空")
        assertTrue(q.onDownloadDone(b, ok = true))
        assertEquals(listOf(b), r.speaks)
        assertEquals(1, r.failed.size)
        assertEquals(a, r.failed[0].first)
    }

    /**
     * 边下边播这一句不许当成「下载完成」：以前复用回调，读完字节就放出下一句，
     * 而这一句其实还在响，两句叠在一起谁也没出声。
     */
    @Test
    fun adoptedStreamHoldsSoundUntilPlayDone() {
        val r = Recorder()
        val q = queue(r)
        val a = q.enqueue("流式这句。", "p", 1L, cached = false)
        val b = q.enqueue("下一句。", "p", 2L, cached = false)
        assertTrue(q.busy())

        assertTrue(q.adoptStream(a))
        // 槽位还了（下一句能下），但声音还被这句占着
        assertEquals(1, q.downloading())
        assertTrue(q.onDownloadDone(b, ok = true))
        assertTrue(r.speaks.isEmpty())

        q.onPlayDone(a)
        assertEquals(listOf(b), r.speaks)
    }

    /** 打断后旧轮的流才接上：不许认领，否则新轮永远等不到出声。 */
    @Test
    fun adoptStreamRejectsStaleTurn() {
        val r = Recorder()
        val q = queue(r)
        q.enqueue("旧一句。", "p", 1L, cached = false)
        q.stopAll()
        assertFalse(q.adoptStream(1L))
        // 旧轮的下载槽位还在途，不许被这一认领顶成「正在响」
        assertTrue(r.speaks.isEmpty())
    }
}
