plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val buildNo = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "com.ahmedrabie.cubecrush"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.ahmedrabie.cubecrush"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNo
        versionName = "1.0.$buildNo"
    }
    signingConfigs {
        create("rel") {
            storeFile = file("../keystore/cubecrush.jks")
            storePassword = "cubecrush"
            keyAlias = "cubecrush"
            keyPassword = "cubecrush"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("rel")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
