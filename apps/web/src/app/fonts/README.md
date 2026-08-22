# Local application fonts

These Latin WOFF2 files are immutable production build inputs. They remove the
runtime and build-time dependency on Google Fonts while preserving the existing
font families, weights, styles, CSS variables, and preload policy.

| File | Upstream | SHA-256 |
| --- | --- | --- |
| `inter-latin.woff2` | Google Fonts, Inter v20 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `jetbrains-mono-latin.woff2` | Google Fonts, JetBrains Mono v24 | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` |
| `eb-garamond-normal-latin.woff2` | Google Fonts, EB Garamond v33 | `88603384163d301aebd5bd769832a8bfe3c9004ec24178417b9817f0ad32c63b` |
| `eb-garamond-italic-latin.woff2` | Google Fonts, EB Garamond v33 | `c664773f7e1d42d36326aa457becf7674236168c74cf7d74e87e5778ef7640f9` |
| `im-fell-english-normal-latin.woff2` | Google Fonts, IM Fell English v14 | `248300df1647bec49155a5cada1d65f719ae633ef48564d1f19b135a8a5b7f5f` |
| `im-fell-english-italic-latin.woff2` | Google Fonts, IM Fell English v14 | `8fc678575e83868f82ce5aa6e023f056ea68d480e16dd108b3e14bc375c8fdea` |
| `unifraktur-maguntia-latin.woff2` | Google Fonts, UnifrakturMaguntia v22 | `a467466874b50cd9ffbe10e5caccd9b261f2bc2252bcfa7d160c744ed9da6f15` |

Each family is distributed under the SIL Open Font License included in
`licenses/`. Update a font only as a reviewed asset change: replace the bytes,
the corresponding license, and this digest in one commit, then run the strict
standalone bundle proof.
