import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
const { dispatchLogBatch, dispatchLogToDrain } = await import(
	"../../src/engine/logDrainManager.js"
);
const { extraDrainUrlProblem } = await import(
	"../../src/engine/logDrainTargets.js"
);
const entry = {
	timestamp: "2026-11-10T12:00:00Z",
	service: "web",
	container: "web-7",
	line: "owned endpoint fixture",
};
it("routes an accepted index target to a documented bulk endpoint", async () => {
	const urls: string[] = [];
	let stored = 0;
	const server = createServer((req, res) => {
		const u = new URL(req.url!, "http://fixture");
		if (
			req.method === "POST" &&
			["/_bulk", "/logs-fixture/_bulk"].includes(u.pathname)
		) {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const lines = Buffer.concat(chunks)
					.toString()
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				if (lines[0]?.create?._index !== "logs-fixture") {
					res.writeHead(400);
					res.end("wrong target index");
					return;
				}
				stored += lines.length / 2;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						errors: false,
						items: [{ create: { status: 201 } }],
					}),
				);
			});
		} else if (u.pathname === "/generic") {
			res.writeHead(204);
			res.end();
		} else {
			res.writeHead(405);
			res.end("Unsupported operation for index URL");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing owned listener");
	const fetchImpl = async (url: string, init?: RequestInit) => {
		const u = new URL(url);
		urls.push(url);
		return fetch(
			`http://127.0.0.1:${address.port}${u.pathname}${u.search}`,
			init,
		);
	};
	try {
		const target = "https://elastic.example.test/logs-fixture";
		expect(extraDrainUrlProblem("elasticsearch", target)).toBeNull();
		const outcome = await dispatchLogBatch(
			{ url: target, type: "elasticsearch", format: "json" },
			[entry],
			fetchImpl,
		);
		console.log("EXPECTED: bulk operation and one accepted log; ACTUAL:", {
			urls,
			outcome,
			stored,
		});
		console.log(
			outcome.ok && stored === 1
				? "PROBLEM NOT REPRODUCED"
				: "PROBLEM CONFIRMED",
		);
		expect(outcome).toMatchObject({ ok: true, status: 200 });
		expect(stored).toBe(1);
	} finally {
		const closed = once(server, "close");
		server.close();
		server.closeAllConnections();
		await closed;
	}
});
it("control: ordinary HTTP drains keep their configured URL", async () => {
	const urls: string[] = [];
	const result = await dispatchLogBatch(
		{
			url: "https://receiver.example.test/generic",
			type: "http",
			format: "json",
		},
		[entry],
		async (url) => {
			urls.push(url);
			return new Response(null, { status: 204 });
		},
	);
	expect(result).toMatchObject({ ok: true, status: 204 });
	expect(urls).toEqual(["https://receiver.example.test/generic"]);
});
for (const suffix of [
	"",
	"/",
	"///",
	"?filter_path=errors&refresh=wait_for",
	"/?routing=owned",
]) {
	it(`preserves index, origin, query and headers for endpoint suffix ${suffix}`, async () => {
		const configured = `https://elastic.example.test:9443/logs-fixture${suffix}`;
		const expected = new URL(configured);
		expected.pathname = "/logs-fixture/_bulk";
		for (const single of [true, false]) {
			const drain = {
				url: configured,
				type: "elasticsearch" as const,
				format: "json" as const,
				apiKey: "owned-fixture-key",
				headers: { "X-Owned": "control" },
			};
			const fetchImpl = async (url: string, init?: RequestInit) => {
				expect(url).toBe(expected.toString());
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("ApiKey owned-fixture-key");
				expect(headers.get("X-Owned")).toBe("control");
				expect(headers.get("Content-Type")).toBe("application/x-ndjson");
				const lines = String(init?.body)
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(lines[0]).toEqual({ create: { _index: "logs-fixture" } });
				return new Response('{"errors":false}');
			};
			const result = single
				? await dispatchLogToDrain(drain, entry, fetchImpl)
				: await dispatchLogBatch(drain, [entry], fetchImpl);
			expect(result.ok).toBe(true);
			expect(drain.url).toBe(configured);
		}
	});
}
