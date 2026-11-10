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
const at = new Date("2026-11-10T12:00:00Z"),
	entries = [
		{
			timestamp: at.toISOString(),
			service: "web",
			container: "web-7",
			line: "owned durable fixture",
		},
	];
async function queue(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	url = "https://elastic.example.test/logs-fixture",
) {
	const f = await observabilityDb();
	fixtures.push(f);
	const [drain] = await f.db
		.insert(logDrains)
		.values({ name: "elastic fixture", type: "elasticsearch", url })
		.returning();
	const payload = encrypt(JSON.stringify(entries));
	await f.db
		.insert(logDrainBatches)
		.values({
			drainId: drain!.id,
			serviceId: 1,
			runtimeKey: "owned-fixture",
			binding: logDrainBinding(drain!),
			payloadEncrypted: payload,
			payloadBytes: Buffer.byteLength(payload),
			entryCount: 1,
			nextAttemptAt: at,
			createdAt: at,
		});
	const result = await shipLogsOnce(f.db, {
		readLogs: async () => [],
		dispatch: (target, batch) => dispatchLogBatch(target, batch, fetchImpl),
		now: () => at,
	});
	return {
		result,
		originalPayload: payload,
		rows: await f.db.select().from(logDrainBatches),
	};
}
it("retains captured logs after a native truncated HTTP 200 bulk response", async () => {
	let sever!: () => void;
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write('{"errors":true,"items":[');
		sever = () => res.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing owned listener");
	let receivedHeaders = false;
	try {
		const outcome = await queue(async (_url, init) => {
			const response = await fetch(
				`http://127.0.0.1:${address.port}/fixture`,
				init,
			);
			receivedHeaders = true;
			sever();
			return response;
		});
		console.log(
			"EXPECTED: truncated ack preserves one pending batch, shipped0; ACTUAL:",
			{ receivedHeaders, pending: outcome.rows.length, result: outcome.result },
		);
		const bad = outcome.rows.length !== 1 || outcome.result.shipped !== 0;
		console.log(bad ? "PROBLEM CONFIRMED" : "PROBLEM NOT REPRODUCED");
		expect(receivedHeaders).toBe(true);
		expect(outcome.rows).toHaveLength(1);
		expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
	} finally {
		const closed = once(server, "close");
		server.close();
		server.closeAllConnections();
		await closed;
	}
});
it("control: a complete successful bulk acknowledgement deletes the delivered batch", async () => {
	const outcome = await queue(
		async () =>
			new Response(
				JSON.stringify({ errors: false, items: [{ create: { status: 201 } }] }),
			),
	);
	expect(outcome.rows).toEqual([]);
	expect(outcome.result.shipped).toBe(1);
});

it("retains filtered bulk failures without a top-level errors flag", async () => {
	const outcome = await queue(async (url) => {
		expect(new URL(url).searchParams.get("filter_path")).toBe("items.*.error");
		return new Response(
			JSON.stringify({
				items: [
					{
						create: {
							error: {
								type: "mapper_parsing_exception",
								reason: "owned fixture mapping failure",
							},
						},
					},
				],
			}),
		);
	}, "https://elastic.example.test/logs-fixture?filter_path=items.*.error");
	console.log(
		"EXPECTED: filtered item error keeps one queued batch, shipped0; ACTUAL:",
		{ pending: outcome.rows.length, result: outcome.result },
	);
	const bad = outcome.rows.length !== 1 || outcome.result.shipped !== 0;
	console.log(bad ? "PROBLEM CONFIRMED" : "PROBLEM NOT REPRODUCED");
	expect(outcome.rows).toHaveLength(1);
	expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
});
it("control: explicit errors true is already refused", async () => {
	const outcome = await queue(
		async () =>
			new Response(
				JSON.stringify({
					errors: true,
					items: [{ create: { error: { reason: "owned control rejection" } } }],
				}),
			),
	);
	expect(outcome.rows).toHaveLength(1);
	expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
});

const invalidBodies = [
	["truncated JSON", '{"errors":'],
	["HTML", "<html>sign in</html>"],
	["empty", ""],
	["null", "null"],
	["string", '"ok"'],
	["array", "[]"],
	["wrong items type", '{"errors":false,"items":"bad"}'],
	["numeric flag", '{"errors":0}'],
	["null flag", '{"errors":null}'],
] as const;
for (const [name, body] of invalidBodies)
	it(`retains exact encrypted payload after invalid acknowledgement: ${name}`, async () => {
		const outcome = await queue(async () => new Response(body));
		expect(outcome.rows).toHaveLength(1);
		expect(outcome.rows[0]!.payloadEncrypted).toBe(outcome.originalPayload);
		expect(outcome.rows[0]!.attempts).toBeGreaterThan(0);
		expect(outcome.rows[0]!.nextAttemptAt.getTime()).toBeGreaterThan(
			at.getTime(),
		);
		expect(outcome.result).toMatchObject({ shipped: 0, failed: 1 });
	});
it("refuses a filtered item error without a reason string", async () => {
	const outcome = await queue(
		async () =>
			new Response(
				JSON.stringify({
					items: [{ create: { error: { type: "owned rejection" } } }],
				}),
			),
		"https://elastic.example.test/logs-fixture?filter_path=items.*.error",
	);
	expect(outcome.rows).toHaveLength(1);
	expect(outcome.result.shipped).toBe(0);
});
for (const body of [{}, { items: [{}] }])
	it(`preserves valid filtered acknowledgement ${JSON.stringify(body)}`, async () => {
		const outcome = await queue(
			async () => new Response(JSON.stringify(body)),
			"https://elastic.example.test/logs-fixture?filter_path=items.*.error",
		);
		expect(outcome.rows).toEqual([]);
		expect(outcome.result.shipped).toBe(1);
	});
it("accepts a flag-only successful filter", async () => {
	const outcome = await queue(
		async () => new Response('{"errors":false}'),
		"https://elastic.example.test/logs-fixture?filter_path=errors",
	);
	expect(outcome.rows).toEqual([]);
	expect(outcome.result.shipped).toBe(1);
});
it("refuses a flag-only failed filter", async () => {
	const outcome = await queue(
		async () => new Response('{"errors":true}'),
		"https://elastic.example.test/logs-fixture?filter_path=errors",
	);
	expect(outcome.rows).toHaveLength(1);
	expect(outcome.result.shipped).toBe(0);
});
