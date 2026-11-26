# Example officers for vyugate

Two officers for the first target repository, vyugate, shipped here as examples with their tests.
An officer is one check command listed in the target's `.claude/kh-orchestration/officers.json`: it
exits 0 to pass and non-zero to fail, and a commit whose tree has not passed every officer is
refused. Nothing in this directory is installed anywhere by kh-orchestration; the owner copies the
files.

Each officer is a standalone script: it imports nothing from kh-orchestration and runs with the
runner's environment (`KO_OPTIONS`, `KO_BASE`, `KO_TREE`, `KO_CHANGED_FILE`, `KO_WAIVERS`) in the
repository root.

## `docs-with-logic.mjs` (rule V8: a logic or architecture change updates the docs)

Options: `{ "logic": [glob...], "docs": [glob...] }`, both required, no other key.

It fails when at least one changed path matches a `logic` glob and no changed path matches a `docs`
glob. It names up to 20 of the logic paths (then "and N more") and says to update a documentation
path or to ask the owner for a waiver of V8 with a reason. It passes when a docs path changed, when
no logic path changed, or when a waiver for `V8` is in force on the branch (it prints the reason
on one line, control characters made visible). Malformed input (options, waivers or the changed-paths
file) fails with exit 1 and fixed text.

Limits:

- It checks that SOME documentation path changed, not that the right one did, nor that the text
  says anything about the change. It is a prompt to the author, not a reading of the docs.
- A deleted path and both sides of a rename count as changed, so moving a file out of a logic
  directory is a logic change.
- Globs follow the plugin's rules (`**/` matches zero or more directories, a trailing `/**` matches
  everything under a directory, `*` and `?` never cross `/`); an invalid glob fails the officer.
  The script carries its own copy of the matcher, and `docs-with-logic.test.mjs` asserts that the
  copy agrees with the plugin's on one table. If the plugin's rules change, copy the matcher again.
- `officers.example.json` holds placeholder globs (`PLACEHOLDER-logic-directory/**`,
  `PLACEHOLDER-docs-directory/**`). JSON has no comments, so this note is the marker: the owner
  must replace both lists with vyugate's real logic and documentation paths. Until then the officer
  never fails, because no path matches a placeholder.

## `migrations-append-only.py` (rule V11: database migrations are append-only)

Options: `{ "file": "<path>", "name": "MIGRATIONS" }`, both optional; the defaults are
`products/vision/backend/src/vyugate_api/db.py` and `MIGRATIONS`. Python 3, standard library only.

It reads the file at the base commit and in the tree with `git`, finds the module-level list
assignment of that name (plain or annotated, `MIGRATIONS: list[str] = [...]`) with the `ast` module,
and passes only when the base list is an exact prefix of the current one. Elements are compared by
`ast.dump`, so reformatting, comments and a trailing comma do not matter, while changing an element
(including replacing one name by another) does. A failure names the element's 0-based index and its
source, cut to 80 characters, for an element edited in place, removed, reordered or preceded by a
new one.

Names are checked too. vyugate's list holds names (`SCHEMA_V1`), and comparing names would not
notice an edit to the string a name refers to. So for each element of the base list that is a bare
name, the module-level assignment of that name must be present exactly once in both versions with
the same `ast.dump` value; otherwise the officer fails naming it.

It passes with nothing to compare when `KO_BASE` is `none` or the file did not exist at the base. It
fails when the file exists at the base and not in the tree, and as unreadable (fixed text) when, in
either version, the source has a syntax error, the name is not assigned, is assigned more than once
at module level (including `+=` and assignments under `if`/`try`), or its value is not a plain list
literal (a call, a comprehension, a `+` expression, a tuple, another name) or holds a starred
element.

Limits:

- A name's value is compared as written. If a migration string is built from another name
  (`SCHEMA_V2 = SCHEMA_V1 + "..."`) or is imported from another file, an edit behind that name is not
  seen. Names must be assigned in the file itself.
- Bindings other than assignment (`import ... as MIGRATIONS`, `def`, `for`, `with ... as`, `del`) are
  not recognised, and nor is a change made at run time (`MIGRATIONS.append(...)`).
- It does not know whether a migration has been applied anywhere; it treats every element of the
  base list as applied.

## Installing them in vyugate

The precise owner commands are in `docs/ROLLOUT-vyugate.md` (written by a later task). The outline:

1. Copy `docs-with-logic.mjs` and `migrations-append-only.py` into vyugate as
   `scripts/officers/docs-with-logic.mjs` and `scripts/officers/migrations-append-only.py`.
2. Add the two officers of `officers.example.json` to vyugate's
   `.claude/kh-orchestration/officers.json`, with V8's two glob lists filled in. Its `protected`
   entry `scripts/officers/**` is how the owner locks the scripts: a change to them then needs the
   owner's approval.
3. In `docs/harness/RULES.md` change V8 and V11 from `enforced-by: review` to `enforced-by: officer`
   with `pointer:` the script's path.
4. Stage the changes, approve them, run the officers, and commit, as the rollout document says.

Run the tests of this directory with `node --test "examples/**/*.test.mjs"`; the V11 tests need
`python3` on `PATH` and are skipped, with that message, when it is not.
