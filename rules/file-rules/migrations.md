### Migrations & schema changes

- **Migration & schema consistency** — a new or edited migration (especially a
  baseline) must be SHAPE-CONSISTENT with the ORM schema and with what the
  other migrations assume: compare each created/altered table's column list
  against the schema definition (`schema.prisma` / `schema.sql`, provided in
  context when migrations change) and against later migrations that reference
  those columns. A later `CREATE TABLE IF NOT EXISTS` silently no-ops, so
  columns missing from the earlier shape are NEVER added; a later index / FK /
  `UPDATE ... WHERE col` on an absent column fails the whole deploy. A baseline
  that omits columns live code queries breaks every fresh install = **P1**.
