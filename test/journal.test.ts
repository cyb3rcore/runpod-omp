import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, resolveJournalPath } from "../src/journal.js";

describe("runpod request journal", () => {
	test("resolveJournalPath is disabled by default and opt-in via the env", () => {
		expect(resolveJournalPath({})).toBeUndefined();
		expect(resolveJournalPath({ RUNPOD_OMP_LOG: "" })).toBeUndefined();
		expect(resolveJournalPath({ RUNPOD_OMP_LOG: "/tmp/custom.jsonl" })).toBe("/tmp/custom.jsonl");
	});

	test("a disabled journal never throws and writes nothing", () => {
		const journal = createJournal(undefined);
		expect(() => journal.record({ kind: "test", n: 1 })).not.toThrow();
	});

	test("an enabled journal appends JSONL entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "runpod-journal-"));
		const path = join(dir, "journal.jsonl");
		const journal = createJournal(path);

		journal.record({ kind: "a", n: 1 });
		journal.record({ kind: "b", nested: { x: true } });

		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		expect(lines).toEqual([
			{ kind: "a", n: 1 },
			{ kind: "b", nested: { x: true } },
		]);
	});
});
