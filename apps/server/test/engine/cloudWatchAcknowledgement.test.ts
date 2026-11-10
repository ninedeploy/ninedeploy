import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { logDrainBatches, logDrains } from "@ninedeploy/db";
vi.hoisted(() => {
	process.env["NINEDEPLOY_MASTER_KEY"] = "ab".repeat(32);
});
const { observabilityDb } = await import("../fixtures/observability.js");
const { encrypt } = await import("../../src/lib/crypto.js");
const { shipLogsOnce, logDrainBinding } = await import(
	"../../src/engine/logShipper.js"
);
const { dispatchLogBatch } = await import(
	"../../src/engine/logDrainManager.js"
);
const fixtures: Array<Awaited<ReturnType<typeof observabilityDb>>> = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.close();
});

async function deliver(responseBody: object) {
	const f = await observabilityDb();
	fixtures.push(f);
	const at = new Date("2026-11-10T12:00:00Z");
	const [drain] = await f.db
		.insert(logDrains)
		.values({
			name: "owned cloudwatch fixture",
			type: "cloudwatch",
			url: "https://logs.eu-west-1.amazonaws.com/?group=owned&stream=fixture",
			apiKeyEncrypted: encrypt("OWNED_FIXTURE_ID:owned-fixture-secret"),
		})
		.returning();
	const payload = encrypt(
		JSON.stringify([
			{
				timestamp: at.toISOString(),
				service: "web",
				container: "web-7",
				line: "owned cloudwatch event",
			},
		]),
	);
	await f.db
		.insert(logDrainBatches)
		.values({
			drainId: drain!.id,
			serviceId: 1,
			runtimeKey: "owned-cw",
			binding: logDrainBinding(drain!),
			payloadEncrypted: payload,
			payloadBytes: Buffer.byteLength(payload),
			entryCount: 1,
			nextAttemptAt: at,
			createdAt: at,
		});
	let signedPut = false;
	const server = createServer((req, res) => {
		signedPut =
			req.headers["x-amz-target"] === "Logs_20140328.PutLogEvents" &&
			String(req.headers["authorization"]).startsWith(
				"AWS4-HMAC-SHA256 Credential=OWNED_FIXTURE_ID/",
			);
		req.resume();
		res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
		res.end(JSON.stringify(responseBody));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing owned listener");
	try {
		const result = await shipLogsOnce(f.db, {
			readLogs: async () => [],
			now: () => at,
			dispatch: (target, entries) =>
				dispatchLogBatch(target, entries, async (_url, init) =>
					fetch(`http://127.0.0.1:${address.port}/`, init),
				),
		});
		expect(signedPut).toBe(true);
		return { result, rows: await f.db.select().from(logDrainBatches), payload };
	} finally {
		const closed = once(server, "close");
		server.close();
		server.closeAllConnections();
		await closed;
	}
}

it("retains a log rejected at inclusive too-new index zero despite HTTP 200", async () => {
	const outcome = await deliver({
		rejectedLogEventsInfo: { tooNewLogEventStartIndex: 0 },
	});
	console.log("EXPECTED: one pending event, shipped0; ACTUAL:", {
		pending: outcome.rows.length,
		result: outcome.result,
	});
	console.log(
		outcome.rows.length === 1 && outcome.result.shipped === 0
			? "PROBLEM NOT REPRODUCED"
			: "PROBLEM CONFIRMED",
	);
	expect(outcome.rows).toHaveLength(1);
	expect(outcome.rows[0]!.payloadEncrypted).toBe(outcome.payload);
	expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
});
for (const body of [
	{},
	{ rejectedEntityInfo: { errorType: "InvalidEntity" } },
]) {
	it(`control: accepted events are delivered for ${JSON.stringify(body)}`, async () => {
		const outcome = await deliver(body);
		expect(outcome.rows).toEqual([]);
		expect(outcome.result.shipped).toBe(1);
	});
}

for (const rejectedLogEventsInfo of [
	{ tooOldLogEventEndIndex: 1 },
	{ expiredLogEventEndIndex: 0 },
]) {
	it(
		"retains batches with old or expired event rejections " +
			JSON.stringify(rejectedLogEventsInfo),
		async () => {
			const outcome = await deliver({ rejectedLogEventsInfo });
			expect(outcome.rows).toHaveLength(1);
			expect(outcome.rows[0]!.payloadEncrypted).toBe(outcome.payload);
			expect(outcome.rows[0]!.attempts).toBeGreaterThan(0);
			expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
		},
	);
}
for (const rejectedLogEventsInfo of [{}, { tooOldLogEventEndIndex: 0 }]) {
	it(
		`accepts an empty rejection range ${JSON.stringify(rejectedLogEventsInfo)}`,
		async () => {
			const outcome = await deliver({ rejectedLogEventsInfo });
			expect(outcome.rows).toEqual([]);
			expect(outcome.result.shipped).toBe(1);
		},
	);
}
