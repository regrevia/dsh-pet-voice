package com.whale.pet

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import android.widget.TextView
import java.util.concurrent.Executors

/** 一只项目下的会话列表。 */
class SessionsActivity : Activity() {

    private data class Sess(
        val id: String,
        val title: String,
        val updatedAt: Long,
        val running: Boolean,
    )

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val rows = ArrayList<Sess>()
    private val client by lazy { PetClient { PetSettings.load(this) } }

    private lateinit var projectId: String
    private lateinit var list: ListView
    private lateinit var emptyBox: View
    private lateinit var emptyText: TextView
    private lateinit var more: TextView
    private lateinit var adapter: SessAdapter

    private var nextBefore: Long = 0
    private var hasMore = false
    private var loading = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sessions)
        projectId = intent.getStringExtra(EXTRA_ID).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "会话" }
        findViewById<TextView>(R.id.sessionsTitle).text = title
        list = findViewById(R.id.sessionList)
        emptyBox = findViewById(R.id.sessionsEmpty)
        emptyText = findViewById(R.id.sessionsEmptyText)
        more = TextView(this).apply {
            text = "加载更早"
            setTextColor(getColor(R.color.pet_accent))
            textSize = 14f
            gravity = android.view.Gravity.CENTER
            val pad = (14 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            visibility = View.GONE
            setOnClickListener { loadEarlier() }
        }
        list.addFooterView(more, null, false)
        adapter = SessAdapter()
        list.adapter = adapter
        findViewById<View>(R.id.sessionsBack).setOnClickListener { finish() }
        findViewById<View>(R.id.sessionsRetry).setOnClickListener { load() }
        list.setOnItemClickListener { _, _, position, _ ->
            val s = rows.getOrNull(position) ?: return@setOnItemClickListener
            startActivity(SessionActivity.intent(this, s.id, s.title))
        }
        load()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun load() {
        if (loading) return
        loading = true
        emptyText.text = "读取中"
        emptyBox.visibility = View.VISIBLE
        io.execute {
            val result = client.sessions(projectId, 20)
            val parsed = parse(result)
            val more = result.json?.optBoolean("hasMore", false) == true
            val next = result.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                loading = false
                rows.clear()
                rows.addAll(parsed)
                hasMore = more
                nextBefore = next
                adapter.notifyDataSetChanged()
                refreshMore()
                if (rows.isEmpty()) {
                    emptyText.text = "还没有会话"
                    emptyBox.visibility = View.VISIBLE
                } else {
                    emptyBox.visibility = View.GONE
                }
            }
        }
    }

    private fun loadEarlier() {
        if (loading || nextBefore <= 0) return
        loading = true
        more.text = "读取中"
        io.execute {
            val result = client.sessions(projectId, 20, nextBefore)
            val parsed = parse(result)
            val moreFlag = result.json?.optBoolean("hasMore", false) == true
            val next = result.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                loading = false
                val seen = rows.map { it.id }.toHashSet()
                val add = parsed.filter { it.id !in seen }
                rows.addAll(add)
                hasMore = moreFlag
                nextBefore = next
                adapter.notifyDataSetChanged()
                refreshMore()
            }
        }
    }

    private fun refreshMore() {
        more.visibility = if (hasMore) View.VISIBLE else View.GONE
        more.text = "加载更早"
    }

    private fun parse(result: PetClient.Result): List<Sess> {
        val out = ArrayList<Sess>()
        val arr = result.json?.optJSONArray("sessions") ?: return out
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id")
            if (id.isBlank()) continue
            out.add(
                Sess(
                    id = id,
                    title = o.optString("title").ifBlank { "未命名会话" },
                    updatedAt = o.optLong("updatedAt", 0),
                    running = o.optBoolean("running", false),
                ),
            )
        }
        return out
    }

    private inner class SessAdapter : BaseAdapter() {
        override fun getCount(): Int = rows.size
        override fun getItem(position: Int): Any? = rows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_session, parent, false)
            val s = rows[position]
            v.findViewById<TextView>(R.id.sessionName).text = s.title
            v.findViewById<TextView>(R.id.sessionTime).text =
                if (s.updatedAt > 0) Ago.of(s.updatedAt) else ""
            val running = v.findViewById<TextView>(R.id.sessionRunning)
            running.visibility = if (s.running) View.VISIBLE else View.GONE
            return v
        }
    }

    companion object {
        private const val EXTRA_ID = "projectId"
        private const val EXTRA_TITLE = "projectTitle"

        fun intent(context: Context, projectId: String, title: String): Intent =
            Intent(context, SessionsActivity::class.java)
                .putExtra(EXTRA_ID, projectId)
                .putExtra(EXTRA_TITLE, title)
    }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 月-日。 */
object Ago {
    fun of(ms: Long): String {
        if (ms <= 0) return ""
        val diff = System.currentTimeMillis() - ms
        if (diff < 60_000) return "刚刚"
        val minutes = diff / 60_000
        if (minutes < 60) return "${minutes} 分钟前"
        val hours = minutes / 60
        if (hours < 24) return "${hours} 小时前"
        val days = hours / 24
        if (days < 30) return "${days} 天前"
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = ms }
        val month = cal.get(java.util.Calendar.MONTH) + 1
        val day = cal.get(java.util.Calendar.DAY_OF_MONTH)
        return "$month-$day"
    }
}
