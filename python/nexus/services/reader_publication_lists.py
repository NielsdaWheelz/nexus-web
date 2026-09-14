"""Freeze HTML list ordinals before partitioning the private render tree."""

from dataclasses import dataclass, field

from lxml import etree


def _integer(value: str | None) -> int | None:
    if value is None:
        return None
    position = 0
    while position < len(value) and value[position] in " \t\n\r\f":
        position += 1
    negative = position < len(value) and value[position] == "-"
    if position < len(value) and value[position] in "+-":
        position += 1
    if position == len(value) or not "0" <= value[position] <= "9":
        return None
    limit = 2**31 if negative else 2**31 - 1
    number = 0
    while position < len(value) and "0" <= value[position] <= "9":
        digit = ord(value[position]) - ord("0")
        if number > (limit - digit) // 10:
            return None
        number = number * 10 + digit
        position += 1
    return -number if negative else number


@dataclass
class _OrderedList:
    start: int | None
    reversed: bool
    items: list[etree._Element] = field(default_factory=list)


def project_reader_list_ordinals(root: etree._Element) -> None:
    # This is a private render tree. Retained source HTML keeps authored bytes.
    # Sanitizers exclude author display/counter CSS; until-found retains its
    # own CSS box while suppressing its descendants.
    ancestors: list[tuple[_OrderedList | None, bool]] = []
    for event, element in etree.iterwalk(root, events=("start", "end")):
        tag = element.tag.lower() if isinstance(element.tag, str) else ""
        if event == "end":
            owner, _suppressed = ancestors.pop()
            if tag == "ol":
                assert owner is not None
                number = owner.start
                if number is None:
                    number = len(owner.items) if owner.reversed else 1
                for item in owner.items:
                    authored = _integer(item.get("value"))
                    if authored is not None:
                        number = authored
                    item.set("value", str(number))
                    number = max(-(2**31), min(2**31 - 1, number + (-1 if owner.reversed else 1)))
            continue
        owner, suppressed = ancestors[-1] if ancestors else (None, False)
        hidden = element.get("hidden")
        has_box = not suppressed and (hidden is None or hidden.lower() == "until-found")
        if tag == "li" and owner is not None and has_box:
            owner.items.append(element)
        if tag == "ol":
            owner = _OrderedList(_integer(element.get("start")), "reversed" in element.attrib)
        elif tag in {"ul", "menu"}:
            owner = None
        ancestors.append((owner, not has_box or hidden is not None))
