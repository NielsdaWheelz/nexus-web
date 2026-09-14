package app.nexus.android.offline.reading

import com.squareup.moshi.JsonReader
import java.io.File
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction

/** Spool a schema-1 text member without allocating its complete JSON string. */
internal fun spoolLegacyReaderString(reader: JsonReader, destination: File): Long {
    require(reader.peek() == JsonReader.Token.STRING)
    var codePoints = 0L
    reader.nextSource().use { source ->
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        InputStreamReader(source.inputStream(), decoder).buffered().use { input ->
            require(input.read() == '"'.code)
            fun nextCharacter(): Int {
                val value = input.read()
                require(value >= 0)
                if (value == '"'.code) return -1
                require(value >= 0x20)
                if (value != '\\'.code) return value
                return when (val escaped = input.read()) {
                    '"'.code, '\\'.code, '/'.code -> escaped
                    'b'.code -> '\b'.code
                    'f'.code -> 0x0c
                    'n'.code -> '\n'.code
                    'r'.code -> '\r'.code
                    't'.code -> '\t'.code
                    'u'.code -> {
                        var scalar = 0
                        repeat(4) {
                            val digit = input.read()
                            require(digit >= 0)
                            val hex = when (digit) {
                                in '0'.code..'9'.code -> digit - '0'.code
                                in 'a'.code..'f'.code -> digit - 'a'.code + 10
                                in 'A'.code..'F'.code -> digit - 'A'.code + 10
                                else -> error("invalid JSON unicode escape")
                            }
                            scalar = scalar * 16 + hex
                        }
                        scalar
                    }
                    else -> error("invalid JSON string escape")
                }
            }
            destination.bufferedWriter(Charsets.UTF_8).use { output ->
                while (true) {
                    val value = nextCharacter()
                    if (value < 0) break
                    val character = value.toChar()
                    if (character.isHighSurrogate()) {
                        val low = nextCharacter()
                        require(low >= 0 && low.toChar().isLowSurrogate())
                        output.write(value)
                        output.write(low)
                    } else {
                        require(!character.isLowSurrogate())
                        output.write(value)
                    }
                    codePoints += 1
                }
                require(input.read() == -1)
            }
        }
    }
    return codePoints
}
