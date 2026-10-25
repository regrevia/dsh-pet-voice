import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 签名材料放在仓库外层的 android/keystore.properties（已 gitignore），构建脚本只读不打印。
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.whale.pet"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.whale.pet"
        minSdk = 26
        targetSdk = 35
        versionCode = 89
        versionName = "0.9.19"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // 离线构建环境没有 lint-gradle 制品（assembleRelease 会触发 lintVitalRelease），
    // 这里显式关掉；静态检查用 `gradle :app:lintDebug` 在联网机器上另跑。
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// 离线构建：JDK 自带 API（HttpURLConnection / SpeechRecognizer / MediaPlayer / Camera2）
// + libs/ 下的本地 jar。zxing-core 是纯 Java 二维码解码库，无 Play Services 依赖。
dependencies {
    implementation(files("libs/zxing-core-3.5.3.jar"))
    testImplementation("junit:junit:4.13.2")
}

// 悬浮窗页面是 anim-pet.js + boot.js + idle.js 内联生成的单文件；
// 改了素材引擎却忘了重跑生成脚本，APK 里就会装着旧页面（曾导致形象空白），
// 所以每次构建先把页面重新生成一遍。
val genPetAsset by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.parentFile
    commandLine("node", "scripts/gen-pet-asset.mjs")
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(genPetAsset)
}
