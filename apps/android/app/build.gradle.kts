import java.net.URI
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val debugBaseUrl = (providers.gradleProperty("nexusAndroidDebugBaseUrl").orNull
    ?: "https://127.0.0.1:3000").trim()
val debugOwnedHost = (providers.gradleProperty("nexusAndroidDebugOwnedHost").orNull
    ?: "127.0.0.1").trim()
val debugCaFileProperty = providers.gradleProperty("nexusAndroidDebugCaFile").orNull
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
// the wire revision every native call sends (X-Nexus-Wire): the web build's generated one
val nexusWire = Regex("""export const WIRE_REVISION = (\d+);""")
    .find(rootProject.file("../web/src/lib/api/wire.gen.ts").readText())
    ?.groupValues?.get(1)
    ?: error("apps/web/src/lib/api/wire.gen.ts names no WIRE_REVISION")

require(debugUri.host == debugOwnedHost) {
    "nexusAndroidDebugBaseUrl host must match nexusAndroidDebugOwnedHost."
}
require(debugUri.scheme == "https") {
    "nexusAndroidDebugBaseUrl must use https."
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
    compileSdk = 36

    defaultConfig {
        applicationId = "app.nexus.android"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeProperty?.toIntOrNull() ?: 1
        versionName = versionNameProperty ?: "1.0"
        buildConfigField("int", "NEXUS_WIRE", nexusWire)
    }

    buildFeatures {
        buildConfig = true
    }

    // This root contains only generated interfaces. Register their producer
    // below so every asset consumer, including lint, depends on it.
    sourceSets.named("main") {
        assets.setSrcDirs(emptyList<String>())
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

}

// The installed interface and isolated reader are build outputs, not source:
// gradle regenerates both from apps/web into src/main/assets before
// any asset consumer runs, so a clean checkout builds. The pdf.js copy is pinned
// by `apps/web/package.json` + `bun.lock` (asserted at run time by
// copy-pdfjs.mjs), so node_modules is not declared as an input.
val webDir = rootProject.projectDir.resolve("../web")
abstract class BuildPackagedUi : Exec() {
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty
}

val buildPackagedUi = tasks.register<BuildPackagedUi>("buildPackagedUi") {
    group = "build"
    description = "Builds the installed application and isolated downloads reader."
    workingDir = webDir
    commandLine("bun", "run", "build:packaged")
    inputs.dir(webDir.resolve("src"))
    inputs.dir(webDir.resolve("scripts"))
    inputs.file(webDir.resolve("vite.shelf.config.ts"))
    inputs.file(webDir.resolve("vite.android.config.ts"))
    inputs.files(fileTree(webDir.resolve("public")) { exclude("pdfjs/**") })
    inputs.property("storageOrigin", providers.environmentVariable("R2_S3_API_ORIGIN").orElse(""))
    inputs.file(webDir.resolve("package.json"))
    inputs.file(webDir.resolve("bun.lock"))
    outputDirectory.set(layout.projectDirectory.dir("src/main/assets"))
}

// Debug trust is a build input scoped to the exact owned host. The generated
// resources never enter release, and absent local CA means system trust only.
abstract class GenerateDebugNetworkSecurity : DefaultTask() {
    @get:Input
    abstract val ownedHost: Property<String>

    @get:Optional
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val caFile: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val output = outputDirectory.get().asFile
        output.deleteRecursively()
        val localTrust = caFile.orNull?.asFile?.let { ca ->
            val raw = output.resolve("raw")
            raw.mkdirs()
            ca.copyTo(raw.resolve("nexus_debug_ca.pem"))
            """
                <domain-config>
                    <domain includeSubdomains="false">${ownedHost.get()}</domain>
                    <trust-anchors>
                        <certificates src="system" />
                        <certificates src="@raw/nexus_debug_ca" />
                    </trust-anchors>
                </domain-config>
            """.trimIndent()
        } ?: ""
        val xml = output.resolve("xml")
        xml.mkdirs()
        xml.resolve("nexus_debug_network_security.xml").writeText("""
            |<?xml version="1.0" encoding="utf-8"?>
            |<network-security-config>
            |    <base-config cleartextTrafficPermitted="true">
            |        <trust-anchors><certificates src="system" /></trust-anchors>
            |    </base-config>
            |$localTrust
            |</network-security-config>
        """.trimMargin())
    }
}

val generateDebugNetworkSecurity = tasks.register<GenerateDebugNetworkSecurity>("generateDebugNetworkSecurity") {
    ownedHost.set(debugOwnedHost)
    if (debugCaFileProperty != null) caFile.set(file(debugCaFileProperty))
    outputDirectory.set(layout.buildDirectory.dir("generated/debug-network-security"))
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(buildPackagedUi, BuildPackagedUi::outputDirectory)
    if (variant.buildType == "debug")
        variant.sources.res?.addGeneratedSourceDirectory(generateDebugNetworkSecurity, GenerateDebugNetworkSecurity::outputDirectory)
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
    implementation("androidx.media3:media3-common:1.11.1")
    implementation("androidx.media3:media3-datasource:1.11.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.11.1")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
