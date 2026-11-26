#!/usr/bin/env python3
"""V11: database migrations are append-only.

A kh-orchestration officer (decision 10), copied into the target repository as a standalone
script: Python 3 standard library only. It reads
    KO_OPTIONS  {"file": "<path>", "name": "MIGRATIONS"}, both optional
    KO_BASE     the base commit id, or the literal "none"
    KO_TREE     the tree id being judged
and compares the module-level list NAME of FILE at the base with the one in the tree. It exits 0
when the base list is an exact prefix of the current one (elements compared by ast.dump, so
formatting and comments do not matter) and every bare name in the base list is assigned the same
value in both versions; it exits 1 otherwise, with fixed text. It needs Python 3.10 or later and
exits 1 with fixed text on an older one.
"""
import sys

MINIMUM_PYTHON = (3, 10)


def version_problem(version):
    """The refusal text when VERSION (a sys.version_info-like tuple) is older than the minimum, else None."""
    if tuple(version[:2]) < MINIMUM_PYTHON:
        return "V11: this officer needs Python %d.%d or later; this is Python %d.%d." % (MINIMUM_PYTHON + tuple(version[:2]))
    return None


if version_problem(sys.version_info) is not None:
    print(version_problem(sys.version_info))
    sys.exit(1)

import ast
import json
import os
import re
import subprocess

DEFAULT_FILE = "products/vision/backend/src/vyugate_api/db.py"
DEFAULT_NAME = "MIGRATIONS"
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
MAX_SHOWN = 80

BAD_OPTIONS = (
    "V11: KO_OPTIONS must be a JSON object whose only keys are file and name, each a non-empty string "
    "with no empty, . or .. segment and no leading or trailing /, name being a Python identifier. "
    "Fix the officer's options in officers.json."
)
GIT_FAILED = "V11: git could not read the repository."
NO_BASE = "V11: nothing to compare: there is no base commit."

NOT_ASSIGNED = "it is not assigned at module level"
ASSIGNED_TWICE = "it is assigned more than once at module level"
NOT_A_LIST = "its value is not a plain list literal"
STARRED = "its list has a starred element"
MAX_HOPS = 16


def not_an_id(variable, kind):
    return "V11: %s is not a full %s id." % (variable, kind)


def absent_at_base(file):
    return "V11: nothing to compare: %s did not exist at the base." % file


def absent_everywhere(file):
    return "V11: %s exists neither at the base nor in the tree; check the file option in officers.json." % file


def removed(file):
    return "V11: %s exists at the base and not in the tree: the migrations file was removed." % file


def syntax_error(file, where):
    return "V11: %s %s has a syntax error." % (file, where)


def too_deep(file, where):
    return "V11: %s %s is too deeply nested to read." % (file, where)


def unreadable(name, file, where, reason):
    return "V11: %s in %s %s could not be read: %s." % (name, file, where, reason)


def differs(name, index, base, tree):
    return (
        "V11: element %d of %s differs from the base; an applied migration may not be changed, removed, "
        "reordered or preceded by a new one, so append at the end. Base: %s Tree: %s" % (index, name, base, tree)
    )


def name_not_assigned_once(ident, index, name, where):
    return "V11: %s (element %d of %s) is not assigned exactly once at module level %s." % (ident, index, name, where)


def name_cycle(ident, index, name, where):
    return "V11: %s (element %d of %s) refers to other names in a cycle or through more than %d names %s." % (
        ident,
        index,
        name,
        MAX_HOPS,
        where,
    )


def name_edited(ident, index, name):
    return "V11: %s (element %d of %s) was edited: the value assigned to it is not the same as at the base." % (
        ident,
        index,
        name,
    )


def passed(name, file, kept, appended):
    return "V11: %s in %s keeps its %d elements of the base and has %d appended." % (name, file, kept, appended)


class Refusal(Exception):
    """The officer's verdict is a failure; the message is the text to print."""


def read_options(text):
    try:
        options = json.loads(text if text is not None else "")
    except ValueError:
        raise Refusal(BAD_OPTIONS)
    if not isinstance(options, dict) or not set(options) <= {"file", "name"}:
        raise Refusal(BAD_OPTIONS)
    file = options.get("file", DEFAULT_FILE)
    name = options.get("name", DEFAULT_NAME)
    if not isinstance(file, str) or not isinstance(name, str) or not name.isidentifier():
        raise Refusal(BAD_OPTIONS)
    if file.startswith("/") or any(segment in ("", ".", "..") for segment in file.split("/")):
        raise Refusal(BAD_OPTIONS)
    return file, name


def git(*argv):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    try:
        result = subprocess.run(["git", *argv], capture_output=True, env=env)
    except OSError:
        raise Refusal(GIT_FAILED)
    if result.returncode != 0:
        raise Refusal(GIT_FAILED)
    return result.stdout


def read_blob(revision, file):
    """The bytes of FILE in REVISION, or None when it is not there."""
    listing = git("ls-tree", "-z", revision, "--", file)
    for entry in listing.split(b"\0"):
        meta, _, path = entry.partition(b"\t")
        fields = meta.split(b" ")
        if path == file.encode() and len(fields) == 3 and fields[1] == b"blob":
            return git("cat-file", "blob", fields[2].decode())
    return None


def module_statements(node):
    """Every statement run at module level, including those inside if, try, with, for, while and match;
    not the bodies of functions and classes."""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(child, (ast.stmt, ast.ExceptHandler, ast.match_case)):
            if isinstance(child, ast.stmt):
                yield child
            yield from module_statements(child)


def assignments(tree, name):
    """One entry per module-level assignment to NAME: the assigned value node, or None when the form
    is not a plain `NAME = value` or `NAME: type = value` (augmented, tuple, chained)."""
    found = []
    for statement in module_statements(tree):
        if isinstance(statement, ast.Assign):
            targets = [{n.id for n in ast.walk(t) if isinstance(n, ast.Name)} for t in statement.targets]
            if any(name in names for names in targets):
                plain = len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name)
                found.append(statement.value if plain else None)
        elif isinstance(statement, ast.AnnAssign):
            if isinstance(statement.target, ast.Name) and statement.target.id == name and statement.value is not None:
                found.append(statement.value)
        elif isinstance(statement, ast.AugAssign):
            if isinstance(statement.target, ast.Name) and statement.target.id == name:
                found.append(None)
    return found


class Version:
    """One version of the file: its parsed module, its source text, and the list NAME."""

    def __init__(self, source, file, name, where):
        self.where = where
        self.text = source.decode("utf-8", "replace")
        try:
            self.tree = ast.parse(source)
        except RecursionError:
            raise Refusal(too_deep(file, where))
        except (SyntaxError, ValueError):
            raise Refusal(syntax_error(file, where))
        found = assignments(self.tree, name)
        if len(found) == 0:
            raise Refusal(unreadable(name, file, where, NOT_ASSIGNED))
        if len(found) > 1:
            raise Refusal(unreadable(name, file, where, ASSIGNED_TWICE))
        if not isinstance(found[0], ast.List):
            raise Refusal(unreadable(name, file, where, NOT_A_LIST))
        if any(isinstance(element, ast.Starred) for element in found[0].elts):
            raise Refusal(unreadable(name, file, where, STARRED))
        self.elements = found[0].elts

    def shown(self, element):
        """The element's source on one line, cut to MAX_SHOWN characters, control characters visible."""
        text = ast.get_source_segment(self.text, element) or ast.unparse(element)
        text = " ".join(text.split())
        cut = text[:MAX_SHOWN] + ("..." if len(text) > MAX_SHOWN else "")
        return "".join(c if c.isprintable() else "\\u%04x" % ord(c) for c in cut)


def final_value(tree, ident):
    """Follows NAME = NAME assignments from IDENT to the value assigned last: ("value", dump or None),
    ("missing", None) when a name on the way is not assigned exactly once, or ("cycle", None)."""
    seen = set()
    while True:
        found = assignments(tree, ident)
        if len(found) != 1:
            return "missing", None
        if not isinstance(found[0], ast.Name):
            return "value", ast.dump(found[0]) if found[0] is not None else None
        seen.add(ident)
        ident = found[0].id
        if ident in seen or len(seen) > MAX_HOPS:
            return "cycle", None


def check(base, current, file, name):
    """The failure lines for a base and a current version, empty when the current one only appends."""
    lines = []
    for index in range(len(base.elements)):
        if index >= len(current.elements) or ast.dump(base.elements[index]) != ast.dump(current.elements[index]):
            shown = "nothing" if index >= len(current.elements) else current.shown(current.elements[index])
            lines.append(differs(name, index, base.shown(base.elements[index]), shown))
            break
    for index, element in enumerate(base.elements):
        if not isinstance(element, ast.Name):
            continue
        values = []
        for version in (base, current):
            status, value = final_value(version.tree, element.id)
            if status != "value":
                message = name_not_assigned_once if status == "missing" else name_cycle
                lines.append(message(element.id, index, name, version.where))
                break
            values.append(value)
        else:
            if values[0] != values[1] or values[0] is None:
                lines.append(name_edited(element.id, index, name))
    return lines


def main(environment):
    file, name = read_options(environment.get("KO_OPTIONS"))
    base_id = environment.get("KO_BASE", "")
    if base_id == "none":
        return NO_BASE
    if not OBJECT_ID.fullmatch(base_id):
        raise Refusal(not_an_id("KO_BASE", "commit"))
    tree_id = environment.get("KO_TREE", "")
    if not OBJECT_ID.fullmatch(tree_id):
        raise Refusal(not_an_id("KO_TREE", "tree"))
    base_source = read_blob(base_id, file)
    current_source = read_blob(tree_id, file)
    if base_source is None:
        if current_source is None:
            raise Refusal(absent_everywhere(file))
        return absent_at_base(file)
    if current_source is None:
        raise Refusal(removed(file))
    base = Version(base_source, file, name, "at the base")
    current = Version(current_source, file, name, "in the tree")
    lines = check(base, current, file, name)
    if lines:
        raise Refusal("\n".join(lines))
    return passed(name, file, len(base.elements), len(current.elements) - len(base.elements))


if __name__ == "__main__":
    try:
        print(main(os.environ))
    except Refusal as refusal:
        print(refusal)
        sys.exit(1)
