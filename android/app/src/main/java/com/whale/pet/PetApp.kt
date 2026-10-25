package com.whale.pet

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.util.concurrent.atomic.AtomicInteger

/**
 * 自己的界面有没有在前台。
 *
 * 悬浮窗是「不在 App 里也能跟它说话」用的；App 一打开，它就正好压在对话页最后几行字上，
 * 所以自有界面在前台时收起，退到后台再出现。
 */
object AppForeground {
    private val depth = AtomicInteger(0)

    @Volatile
    var visible = false
        private set

    /** 在哪个线程被调都行，回调由监听方自己切到主线程。 */
    @Volatile
    var onChange: ((Boolean) -> Unit)? = null

    fun enter() {
        if (depth.incrementAndGet() == 1) publish(true)
    }

    fun exit() {
        if (depth.get() <= 0) return
        if (depth.decrementAndGet() == 0) publish(false)
    }

    private fun publish(v: Boolean) {
        if (visible == v) return
        visible = v
        onChange?.invoke(v)
    }
}

class PetApp : Application() {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) = AppForeground.enter()
            override fun onActivityStopped(activity: Activity) = AppForeground.exit()
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}
