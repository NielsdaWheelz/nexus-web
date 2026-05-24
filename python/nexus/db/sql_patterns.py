"""SQL pattern helpers used to build ILIKE-style match expressions."""


def escape_ilike_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
