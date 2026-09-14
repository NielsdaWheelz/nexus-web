package app.nexus.android.offline.reading

internal object OfflineReaderStateValidator {
    fun requireLocator(json: String): StrictJson.ObjectValue {
        val value = StrictJson.parse(json.toByteArray()) as? StrictJson.ObjectValue
            ?: error("reader locator must be an object")
        val fields = value.fields
        when (fields["kind"]?.requireString()) {
            "pdf" -> {
                fields.requireExact(
                    setOf("kind", "page", "page_progression", "zoom", "position")
                )
                require(fields.getValue("page").requireLong() >= 1)
                fields.getValue("page_progression").requireNullableDouble(0.0, 1.0)
                fields.getValue("zoom").requireNullableDouble(0.25, 4.0)
                fields.getValue("position").requireNullableLong(1)
            }
            "web" -> requireTextLocator(fields, epub = false)
            "epub" -> requireTextLocator(fields, epub = true)
            else -> error("offline reader locator kind is invalid")
        }
        return value
    }

    fun requireCursorSnapshot(json: String): Long {
        val value = StrictJson.parse(json.toByteArray()) as? StrictJson.ObjectValue
            ?: error("reader cursor must be an object")
        val fields = value.fields
        return when (fields["state"]?.requireString()) {
            "Empty" -> {
                fields.requireExact(setOf("state", "revision"))
                fields.getValue("revision").requireLong().also { require(it >= 0) }
            }
            "Positioned" -> {
                fields.requireExact(setOf("state", "revision", "source", "locator"))
                val revision = fields.getValue("revision").requireLong().also { require(it >= 1) }
                val source = fields.getValue("source").requireMap()
                when (source["kind"]?.requireString()) {
                    "Publication" -> {
                        source.requireExact(setOf("kind", "reader_generation"))
                        require(source.getValue("reader_generation").requireLong() > 0)
                    }
                    "Unresolved" -> source.requireExact(setOf("kind"))
                    else -> error("offline reader cursor source is invalid")
                }
                requireLocator(fields.getValue("locator").toJson())
                revision
            }
            else -> error("reader cursor state is invalid")
        }
    }

    private fun requireTextLocator(fields: Map<String, StrictJson>, epub: Boolean) {
        fields.requireExact(setOf("kind", "target", "locations", "text"))
        if (epub) {
            requireEpubTarget(fields.getValue("target"))
        } else {
            val target = fields.getValue("target").requireMap()
            target.requireExact(setOf("fragment_id"))
            requireVisible(target.getValue("fragment_id").requireString())
        }
        val locations = fields.getValue("locations").requireMap()
        locations.requireExact(setOf("text_offset", "progression", "total_progression", "position"))
        locations.getValue("text_offset").requireNullableLong(0)
        locations.getValue("progression").requireNullableDouble(0.0, 1.0)
        locations.getValue("total_progression").requireNullableDouble(0.0, 1.0)
        locations.getValue("position").requireNullableLong(1)
        val text = fields.getValue("text").requireMap()
        text.requireExact(setOf("quote", "quote_prefix", "quote_suffix"))
        val quote = text.getValue("quote").requireNullableBoundedText(256)
        val prefix = text.getValue("quote_prefix").requireNullableBoundedText(128)
        val suffix = text.getValue("quote_suffix").requireNullableBoundedText(128)
        require(quote != null || (prefix == null && suffix == null))
    }

    fun requireEpubTarget(value: StrictJson): Map<String, StrictJson> {
        val target = value.requireMap()
        target.requireExact(setOf("section_id", "href_path", "anchor_id"))
        requireVisible(target.getValue("section_id").requireString())
        requireVisible(target.getValue("href_path").requireString())
        target.getValue("anchor_id").requireNullableVisible()
        return target
    }

    private fun Map<String, StrictJson>.requireExact(keys: Set<String>) {
        require(this.keys == keys)
    }

    private fun StrictJson.requireMap(): Map<String, StrictJson> =
        (this as? StrictJson.ObjectValue)?.fields ?: error("reader field must be an object")

    private fun StrictJson.requireNullableLong(minimum: Long) {
        if (this is StrictJson.NullValue) return
        require(requireLong() >= minimum)
    }

    private fun StrictJson.requireNullableDouble(minimum: Double, maximum: Double) {
        if (this is StrictJson.NullValue) return
        val value = (this as? StrictJson.NumberValue)?.value?.toDoubleOrNull()
            ?: error("reader field must be a finite number or null")
        require(value.isFinite() && value in minimum..maximum)
    }

    private fun StrictJson.requireNullableVisible() {
        if (this is StrictJson.NullValue) return
        requireVisible(requireString())
    }

    private fun StrictJson.requireNullableBoundedText(maximumCodePoints: Int): String? {
        if (this is StrictJson.NullValue) return null
        return requireString().also {
            requireVisible(it)
            require(it.codePointCount(0, it.length) <= maximumCodePoints)
        }
    }

    private fun requireVisible(value: String) {
        require(value.isNotBlank())
    }
}
