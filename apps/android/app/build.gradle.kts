import java.net.URI
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val debugBaseUrl = (providers.gradleProperty("nexusAndroidDebugBaseUrl").orNull
    ?: "http://10.0.2.2:3000").trim()
val debugOwnedHost = (providers.gradleProperty("nexusAndroidDebugOwnedHost").orNull
    ?: "10.0.2.2").trim()
val requestedReleaseBuild = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}
val canonicalReleaseHost = "nexus.nielseriknandal.com"
val releaseBaseUrlProperty = providers.gradleProperty("nexusAndroidReleaseBaseUrl").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_BASE_URL")?.trim()
val releaseOwnedHostProperty = providers.gradleProperty("nexusAndroidReleaseOwnedHost").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_OWNED_HOST")?.trim()
val releaseStoreFileProperty = providers.gradleProperty("nexusAndroidReleaseStoreFile").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_STORE_FILE")?.trim()
val releaseStorePasswordProperty = providers.gradleProperty("nexusAndroidReleaseStorePassword").orNull
    ?: System.getenv("NEXUS_ANDROID_RELEASE_STORE_PASSWORD")
val releaseKeyAliasProperty = providers.gradleProperty("nexusAndroidReleaseKeyAlias").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_KEY_ALIAS")?.trim()
val releaseKeyPasswordProperty = providers.gradleProperty("nexusAndroidReleaseKeyPassword").orNull
    ?: System.getenv("NEXUS_ANDROID_RELEASE_KEY_PASSWORD")
val releaseCertSha256Property = providers.gradleProperty("nexusAndroidReleaseCertSha256").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_CERT_SHA256")?.trim()
val versionCodeProperty = providers.gradleProperty("nexusAndroidVersionCode").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_VERSION_CODE")?.trim()
val versionNameProperty = providers.gradleProperty("nexusAndroidVersionName").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_VERSION_NAME")?.trim()
val nexusGoogleWebClientId = (providers.gradleProperty("nexusGoogleWebClientId").orNull
    ?: System.getenv("NEXUS_GOOGLE_WEB_CLIENT_ID"))?.trim()
val releaseBaseUrl = releaseBaseUrlProperty ?: "https://release-host-required.invalid"
val releaseOwnedHost = releaseOwnedHostProperty ?: "release-host-required.invalid"
val debugUri = URI(debugBaseUrl)
val releaseUri = URI(releaseBaseUrl)
val assetLinksText = rootProject.file("../web/public/.well-known/assetlinks.json").readText()
val assetLinksTextForFingerprintMatch = assetLinksText.replace(":", "").uppercase()

require(debugUri.host == debugOwnedHost) {
    "nexusAndroidDebugBaseUrl host must match nexusAndroidDebugOwnedHost."
}
require(debugUri.scheme == "http" || debugUri.scheme == "https") {
    "nexusAndroidDebugBaseUrl must use http or https."
}
require(
    debugUri.rawUserInfo == null &&
        (debugUri.rawPath.isNullOrEmpty() || debugUri.rawPath == "/") &&
        debugUri.rawQuery == null &&
        debugUri.rawFragment == null
) {
    "nexusAndroidDebugBaseUrl must be an origin without path, query, fragment, or credentials."
}
require(!nexusGoogleWebClientId.isNullOrBlank()) {
    "Set NEXUS_GOOGLE_WEB_CLIENT_ID or a local nexusGoogleWebClientId Gradle property; required by the native Google sign-in flow."
}
if (requestedReleaseBuild) {
    require(!releaseBaseUrlProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseBaseUrl before building release."
    }
    require(!releaseOwnedHostProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseOwnedHost before building release."
    }
    require(releaseUri.scheme == "https") {
        "nexusAndroidReleaseBaseUrl must use https."
    }
    require(releaseUri.host == releaseOwnedHost) {
        "nexusAndroidReleaseBaseUrl host must match nexusAndroidReleaseOwnedHost."
    }
    require(releaseOwnedHost == canonicalReleaseHost) {
        "Android release host must be $canonicalReleaseHost."
    }
    require(
        releaseUri.rawUserInfo == null &&
            (releaseUri.rawPath.isNullOrEmpty() || releaseUri.rawPath == "/") &&
            releaseUri.rawQuery == null &&
            releaseUri.rawFragment == null
    ) {
        "nexusAndroidReleaseBaseUrl must be an origin without path, query, fragment, or credentials."
    }
    require(!assetLinksText.contains("REPLACE_WITH_RELEASE_APK_SIGNING_CERT_SHA256")) {
        "Replace the placeholder assetlinks.json SHA-256 fingerprint before building release."
    }
    require(!releaseCertSha256Property.isNullOrBlank()) {
        "Set nexusAndroidReleaseCertSha256 or NEXUS_ANDROID_RELEASE_CERT_SHA256 before building release."
    }
    require(
        assetLinksTextForFingerprintMatch.contains(
            releaseCertSha256Property.replace(":", "").uppercase()
        )
    ) {
        "assetlinks.json must contain the Android release signing certificate SHA-256 fingerprint."
    }
    require(!releaseStoreFileProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseStoreFile or NEXUS_ANDROID_RELEASE_STORE_FILE before building release."
    }
    require(file(releaseStoreFileProperty).isFile) {
        "Android release keystore file does not exist: $releaseStoreFileProperty"
    }
    require(!releaseStorePasswordProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseStorePassword or NEXUS_ANDROID_RELEASE_STORE_PASSWORD before building release."
    }
    require(!releaseKeyAliasProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseKeyAlias or NEXUS_ANDROID_RELEASE_KEY_ALIAS before building release."
    }
    require(!releaseKeyPasswordProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseKeyPassword or NEXUS_ANDROID_RELEASE_KEY_PASSWORD before building release."
    }
    require(versionCodeProperty?.toIntOrNull()?.let { it > 0 } == true) {
        "Set nexusAndroidVersionCode or NEXUS_ANDROID_VERSION_CODE to a positive integer before building release."
    }
    require(!versionNameProperty.isNullOrBlank()) {
        "Set nexusAndroidVersionName or NEXUS_ANDROID_VERSION_NAME before building release."
    }
}

android {
    namespace = "app.nexus.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.nexus.android"
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeProperty?.toIntOrNull() ?: 1
        versionName = versionNameProperty ?: "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            storeFile = file(releaseStoreFileProperty ?: "release-keystore-required.jks")
            storePassword = releaseStorePasswordProperty ?: ""
            keyAlias = releaseKeyAliasProperty ?: ""
            keyPassword = releaseKeyPasswordProperty ?: ""
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "NEXUS_BASE_URL", "\"$debugBaseUrl\"")
            buildConfigField("String", "NEXUS_OWNED_HOST", "\"$debugOwnedHost\"")
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$nexusGoogleWebClientId\"")
            manifestPlaceholders["appLinkHost"] = debugOwnedHost
            manifestPlaceholders["appLinksAutoVerify"] = "false"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }

        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            buildConfigField("String", "NEXUS_BASE_URL", "\"$releaseBaseUrl\"")
            buildConfigField("String", "NEXUS_OWNED_HOST", "\"$releaseOwnedHost\"")
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$nexusGoogleWebClientId\"")
            manifestPlaceholders["appLinkHost"] = releaseOwnedHost
            manifestPlaceholders["appLinksAutoVerify"] = "true"
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        animationsDisabled = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.6.1")
}
