plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appVersionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val appVersionName = (project.findProperty("versionName") as String?)?.takeIf { it.isNotBlank() } ?: "1.0.0"

val releaseKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
    ?: (project.findProperty("ANDROID_KEYSTORE_PATH") as String?)
val releaseKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
    ?: (project.findProperty("ANDROID_KEYSTORE_PASSWORD") as String?)
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
    ?: (project.findProperty("ANDROID_KEY_ALIAS") as String?)
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
    ?: (project.findProperty("ANDROID_KEY_PASSWORD") as String?)
    ?: releaseKeystorePassword

val hasReleaseSigning = !releaseKeystorePath.isNullOrBlank() &&
    !releaseKeystorePassword.isNullOrBlank() &&
    !releaseKeyAlias.isNullOrBlank() &&
    !releaseKeyPassword.isNullOrBlank() &&
    file(releaseKeystorePath).exists()

android {
    namespace = "de.entencenter.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.entencenter.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += listOf(
                "META-INF/LICENSE*",
                "META-INF/NOTICE*"
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
