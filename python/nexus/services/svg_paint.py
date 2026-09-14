"""The publisher owns CSS resource semantics; readers own admitted construction.

Literal paint remains CSS so modern colors, currentColor and theme expressions
retain their meaning. Only this producer parses that literal's resource grammar.
Native readers verify the closed wire shape and exact member bytes, not a second
CSS grammar. Local URLs become decoded identifiers, never duplicated raw CSS.
"""

from urllib.parse import unquote

from tinycss2 import parse_component_value_list, serialize
from tinycss2.ast import FunctionBlock, StringToken, URLToken

from nexus.schemas.reader_publication import ReaderPublicationLocalFragment


def _resource_free(tokens: list) -> bool:
    pending = list(tokens)
    while pending:
        token = pending.pop()
        if token.type in {"url", "error"}:
            return False
        if token.type == "function":
            if token.lower_name == "url":
                return False
            pending.extend(token.arguments)
        elif token.type in {"() block", "[] block", "{} block"}:
            pending.extend(token.content)
    return True


def project_svg_paint(value: str) -> str | ReaderPublicationLocalFragment | None:
    """Reject external resources and separate a local URL from its literal fallback."""
    tokens = parse_component_value_list(value, skip_comments=True)
    significant = [token for token in tokens if token.type != "whitespace"]
    if not significant:
        return value
    first = significant[0]
    if isinstance(first, URLToken):
        reference = first.value
    elif isinstance(first, FunctionBlock) and first.lower_name == "url":
        arguments = [token for token in first.arguments if token.type != "whitespace"]
        if len(arguments) != 1 or not isinstance(arguments[0], StringToken):
            return None
        reference = arguments[0].value
    else:
        return value if _resource_free(tokens) else None
    if not reference.startswith("#") or len(reference) == 1:
        return None
    following = tokens[tokens.index(first) + 1 :]
    # CSS EOF closes an otherwise valid unquoted URL token. tinycss2 retains
    # that token plus a trailing diagnostic; the diagnostic is not fallback CSS.
    if (
        isinstance(first, URLToken)
        and following
        and (following[-1].type == "error" and following[-1].kind == "eof-in-url")
    ):
        following = following[:-1]
    if not _resource_free(following):
        return None
    # CSS escaped surrogate codepoints denote the replacement character.
    # tinycss2 currently exposes them verbatim; preserve all other scalar values.
    fragment_id = "".join(
        "\ufffd" if 0xD800 <= ord(point) <= 0xDFFF else point for point in unquote(reference[1:])
    )
    return ReaderPublicationLocalFragment(
        fragment_id=fragment_id, fallback=serialize(following).strip() or None
    )
