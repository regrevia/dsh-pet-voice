package com.whale.pet

import android.app.Activity
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

/** 项目列表：App 版 DSH 的第一层。 */
class ProjectsActivity : Activity() {

    private data class Proj(val id: String, val title: String, val path: String)

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val rows = ArrayList<Proj>()
    private val client by lazy { PetClient { PetSettings.load(this) } }

    private lateinit var list: ListView
    private lateinit var emptyBox: View
    private lateinit var emptyText: TextView
    private lateinit var adapter: ProjectAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_projects)
        list = findViewById(R.id.projectList)
        emptyBox = findViewById(R.id.projectEmpty)
        emptyText = findViewById(R.id.projectEmptyText)
        adapter = ProjectAdapter()
        list.adapter = adapter
        findViewById<View>(R.id.projectsBack).setOnClickListener { finish() }
        findViewById<View>(R.id.projectRetry).setOnClickListener { load() }
        list.setOnItemClickListener { _, _, position, _ ->
            val p = rows.getOrNull(position) ?: return@setOnItemClickListener
            startActivity(SessionsActivity.intent(this, p.id, p.title))
        }
        load()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun load() {
        emptyText.text = "读取中"
        emptyBox.visibility = View.VISIBLE
        io.execute {
            val result = client.projects()
            val parsed = ArrayList<Proj>()
            val arr = result.json?.optJSONArray("projects")
            if (result.ok && arr != null) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val id = o.optString("id")
                    if (id.isBlank()) continue
                    parsed.add(Proj(id, o.optString("title").ifBlank { "未命名" }, o.optString("path")))
                }
            }
            ui.post {
                rows.clear()
                rows.addAll(parsed)
                adapter.notifyDataSetChanged()
                if (rows.isEmpty()) {
                    emptyText.text = "读不到项目"
                    emptyBox.visibility = View.VISIBLE
                } else {
                    emptyBox.visibility = View.GONE
                }
            }
        }
    }

    private inner class ProjectAdapter : BaseAdapter() {
        override fun getCount(): Int = rows.size
        override fun getItem(position: Int): Any? = rows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_project, parent, false)
            val p = rows[position]
            v.findViewById<TextView>(R.id.projectName).text = p.title
            val path = v.findViewById<TextView>(R.id.projectPath)
            if (p.path.isBlank()) {
                path.visibility = View.GONE
            } else {
                path.visibility = View.VISIBLE
                path.text = p.path
            }
            return v
        }
    }

    companion object {
        fun intent(context: android.content.Context): Intent =
            Intent(context, ProjectsActivity::class.java)
    }
}
