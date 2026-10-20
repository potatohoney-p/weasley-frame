import assert from "node:assert/strict";
import * as mutations from "../../../frontend/convex/datasetRows.js";

export type RecordDoc = Record<string, any>;

// This deliberately does not simulate Convex transaction rollback or auth
// dispatch. It invokes real exported handlers and records their storage calls.
export function fixture(data: Record<string, unknown> = { name: "Alpha" }, ownerId = "system") {
  const documents = new Map<string, RecordDoc>([
    ["dataset", { _id: "dataset", ownerId, columns: [{ name: "name" }], rowCount: 1, maxRowCount: 100 }],
    ["row", { _id: "row", datasetId: "dataset", data: structuredClone(data) }],
  ]);
  const writes: Array<{ kind: string; id?: string; table?: string; value?: RecordDoc }> = [];
  let sequence = 0;
  const tableOf = (id: string) => id === "dataset" ? "datasets"
    : id === "row" ? "datasetRows" : id.split(":")[0];
  const db = {
    get: async (id: string) => structuredClone(documents.get(id) ?? null),
    query: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const read = () => [...documents.entries()]
        .filter(([id, value]) => tableOf(id) === table && filters.every(([key, expected]) => value[key] === expected))
        .map(([, value]) => structuredClone(value));
      const chain = {
        withIndex: (_name: string, callback: (q: any) => unknown) => {
          const q = { eq: (key: string, value: unknown) => { filters.push([key, value]); return q; } };
          callback(q);
          return chain;
        },
        collect: async () => read(),
        unique: async () => {
          const values = read();
          assert.ok(values.length <= 1);
          return values[0] ?? null;
        },
      };
      return chain;
    },
    insert: async (table: string, value: RecordDoc) => {
      const id = `${table}:${++sequence}`;
      writes.push({ kind: "insert", table, value: structuredClone(value) });
      documents.set(id, { _id: id, ...structuredClone(value) });
      return id;
    },
    patch: async (id: string, value: RecordDoc) => {
      assert.ok(documents.has(id), "patch must not create a missing row");
      writes.push({ kind: "patch", id, value: structuredClone(value) });
      const document = documents.get(id)!;
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) delete document[key];
        else document[key] = structuredClone(item);
      }
    },
    delete: async (id: string) => {
      writes.push({ kind: "delete", id });
      documents.delete(id);
    },
  };
  return { ctx: { db }, documents, writes, row: () => documents.get("row")! };
}

export function invoke(name: keyof typeof mutations, state: ReturnType<typeof fixture>, args: RecordDoc): Promise<any> {
  const mutation = mutations[name] as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> };
  assert.equal(typeof mutation?._handler, "function", `${name} must expose a Convex handler`);
  return mutation._handler(state.ctx, args);
}

