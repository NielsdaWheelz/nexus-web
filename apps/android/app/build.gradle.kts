import java.io.File
import java.net.URI
import java.security.MessageDigest
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val debugBaseUrl = (providers.gradleProperty("nexusAndroidDebugBaseUrl").orNull
    ?: "http://10.0.2.2:3000").trim()
val debugOwnedHost = (providers.gradleProperty("nexusAndroidDebugOwnedHost").orNull
    ?: "10.0.2.2").trim()
val debugApiOrigin = (providers.gradleProperty("nexusAndroidDebugApiOrigin").orNull
    ?: "http://10.0.2.2:8000").trim()
val requestedReleaseBuild = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}
val canonicalReleaseHost = "nexus.nielseriknandal.com"
val releaseBaseUrlProperty = providers.gradleProperty("nexusAndroidReleaseBaseUrl").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_BASE_URL")?.trim()
val releaseOwnedHostProperty = providers.gradleProperty("nexusAndroidReleaseOwnedHost").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_OWNED_HOST")?.trim()
val releaseApiOriginProperty = providers.gradleProperty("nexusAndroidReleaseApiOrigin").orNull?.trim()
    ?: System.getenv("NEXUS_ANDROID_RELEASE_API_ORIGIN")?.trim()
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
val instrumentationBuildType = providers
    .gradleProperty("nexusAndroidInstrumentationBuildType")
    .orNull
    ?.trim()
    ?: "debug"
val releaseBaseUrl = releaseBaseUrlProperty ?: "https://release-host-required.invalid"
val releaseOwnedHost = releaseOwnedHostProperty ?: "release-host-required.invalid"
val releaseApiOrigin = releaseApiOriginProperty ?: "https://release-api-origin-required.invalid"
val debugUri = URI(debugBaseUrl)
val releaseUri = URI(releaseBaseUrl)
val debugApiUri = URI(debugApiOrigin)
val releaseApiUri = URI(releaseApiOrigin)
val assetLinksText = rootProject.file("../web/public/.well-known/assetlinks.json").readText()
val assetLinksTextForFingerprintMatch = assetLinksText.replace(":", "").uppercase()

require(debugUri.host == debugOwnedHost) {
    "nexusAndroidDebugBaseUrl host must match nexusAndroidDebugOwnedHost."
}
require(debugUri.scheme == "http" || debugUri.scheme == "https") {
    "nexusAndroidDebugBaseUrl must use http or https."
}
require(
    (debugApiUri.scheme == "http" || debugApiUri.scheme == "https") &&
        debugApiUri.rawUserInfo == null &&
        (debugApiUri.rawPath.isNullOrEmpty() || debugApiUri.rawPath == "/") &&
        debugApiUri.rawQuery == null &&
        debugApiUri.rawFragment == null
) {
    "nexusAndroidDebugApiOrigin must be an http(s) origin without path, query, fragment, or credentials."
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
require(instrumentationBuildType == "debug" || instrumentationBuildType == "release") {
    "nexusAndroidInstrumentationBuildType must be debug or release."
}
if (requestedReleaseBuild) {
    require(!releaseBaseUrlProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseBaseUrl before building release."
    }
    require(!releaseOwnedHostProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseOwnedHost before building release."
    }
    require(!releaseApiOriginProperty.isNullOrBlank()) {
        "Set nexusAndroidReleaseApiOrigin or NEXUS_ANDROID_RELEASE_API_ORIGIN before building release."
    }
    require(
        releaseApiUri.scheme == "https" &&
            releaseApiUri.rawUserInfo == null &&
            (releaseApiUri.rawPath.isNullOrEmpty() || releaseApiUri.rawPath == "/") &&
            releaseApiUri.rawQuery == null &&
            releaseApiUri.rawFragment == null
    ) {
        "nexusAndroidReleaseApiOrigin must be an HTTPS origin without path, query, fragment, or credentials."
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
    compileSdk = 36
    testBuildType = instrumentationBuildType

    defaultConfig {
        applicationId = "app.nexus.android"
        minSdk = 26
        targetSdk = 36
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
            buildConfigField("String", "NEXUS_API_ORIGIN", "\"$debugApiOrigin\"")
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
            buildConfigField("String", "NEXUS_API_ORIGIN", "\"$releaseApiOrigin\"")
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
        unitTests.isIncludeAndroidResources = true
    }

    sourceSets {
        // Test-only fixture plumbing (canonical offline-reading ZIP assembly) shared by the
        // JVM host lane and the instrumented device lane so both drive the real verifiers.
        getByName("test").java.srcDir("src/sharedTest/java")
        getByName("androidTest").java.srcDir("src/sharedTest/java")
    }
}

tasks.withType<Test>().configureEach {
    systemProperty(
        "nexus.testdata.offlineReadingContract",
        rootProject.file("../../testdata/offline-reading-contract-v1.json").absolutePath,
    )
}

val verifyOfflineReadingAssets = tasks.register("verifyOfflineReadingAssets") {
    group = "verification"
    description = "Verifies the committed zero-network offline reader asset closure."
    val assetRoot = layout.projectDirectory.dir("src/main/assets/nexus-offline")
    inputs.dir(assetRoot)
    doLast {
        val root = assetRoot.asFile
        val manifestFile = root.resolve("asset-manifest.sha256")
        check(manifestFile.isFile) { "Generate offline reader assets with bun run build:offline-reading." }
        val declared = manifestFile.readLines()
            .filter(String::isNotBlank)
            .associate { line ->
                val parts = line.split("  ", limit = 2)
                check(parts.size == 2 && parts[0].matches(Regex("[0-9a-f]{64}"))) {
                    "Malformed offline reader asset manifest entry."
                }
                parts[1] to parts[0]
            }
        val actual = root.walkTopDown()
            .filter(File::isFile)
            .map { it.relativeTo(root).invariantSeparatorsPath }
            .filter { it != "asset-manifest.sha256" }
            .toSet()
        check(declared.keys == actual) { "Offline reader asset closure is stale." }
        for ((relative, expected) in declared) {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(root.resolve(relative).readBytes())
                .joinToString("") { "%02x".format(it) }
            check(digest == expected) { "Offline reader asset digest is stale: $relative" }
        }
        val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
        val sourceManifest = root.resolve("source-manifest.sha256")
        for (line in sourceManifest.readLines().filter(String::isNotBlank)) {
            val parts = line.split("  ", limit = 2)
            check(parts.size == 2 && parts[0].matches(Regex("[0-9a-f]{64}"))) {
                "Malformed offline reader source manifest entry."
            }
            val source = repositoryRoot.resolve(parts[1]).canonicalFile
            check(source.isFile && source.path.startsWith(repositoryRoot.path + File.separator)) {
                "Offline reader source manifest escapes or names a missing input: ${parts[1]}"
            }
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(source.readBytes())
                .joinToString("") { "%02x".format(it) }
            check(digest == parts[0]) { "Offline reader assets are stale for source: ${parts[1]}" }
        }
    }
}

tasks.named("preBuild") {
    dependsOn(verifyOfflineReadingAssets)
}

tasks.named("check") {
    dependsOn(verifyOfflineReadingAssets)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("androidx.media3:media3-common:1.10.1")
    implementation("androidx.media3:media3-database:1.10.1")
    implementation("androidx.media3:media3-datasource:1.10.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.10.1")
    implementation("androidx.media3:media3-exoplayer:1.10.1")
    implementation("androidx.media3:media3-session:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("com.squareup.moshi:moshi:1.15.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jsoup:jsoup:1.21.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.test:core-ktx:1.6.1")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.robolectric:robolectric:4.14.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.6.1")
}
