package app.nexus.android.offline.reading

/**
 * Marks the signed physical promotion owner. The plain `android-device` sweep
 * excludes this exact annotation: the promotion scenarios require the staged
 * signed baseline, the dedicated synthetic account, and the operator-driven
 * force-stop/reboot/airplane steps, so they run only in the signed release lane.
 */
@Retention(AnnotationRetention.RUNTIME)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION)
annotation class SignedPromotion
