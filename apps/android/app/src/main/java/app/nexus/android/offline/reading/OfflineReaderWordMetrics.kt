package app.nexus.android.offline.reading

/** PostgreSQL [[:space:]] under the existing document metrics locale. */
internal fun isReaderMetricWordSeparator(character: Char): Boolean {
    val code = character.code
    return code in 0x09..0x0d || code == 0x20 || code == 0x1680 ||
        code in 0x2000..0x2006 || code in 0x2008..0x200a ||
        code == 0x2028 || code == 0x2029 || code == 0x205f || code == 0x3000
}
