pluginManagement {
    resolutionStrategy {
        eachPlugin {
            when (requested.id.id) {
                "com.android.application" ->
                    useModule("com.android.tools.build:gradle:${requested.version}")
                "org.jetbrains.kotlin.android" ->
                    useModule("org.jetbrains.kotlin:kotlin-gradle-plugin:${requested.version}")
            }
        }
    }
    repositories {
        // 本地离线 Maven 仓库：由 ~/.gradle/caches/modules-2/files-2.1 生成标准布局的软链，
        // 不依赖 Gradle 的离线元数据缓存。
        maven { url = uri("file:///tmp/m2flat") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("file:///tmp/m2flat") }
        google()
        mavenCentral()
    }
}

rootProject.name = "WhalePet"
include(":app")
