// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// sui-stage — the reusable core of full-lifecycle staging against a throwaway localnet.
//
// Extracted verbatim-in-spirit from the raffle stress driver that survived three real runs:
// the 500-entrant clean pass and the 60,000-entrant storms that measured 187 tx/s and exposed
// the checkpoint-lag race this library now guards against. A scenario file imports these
// primitives and describes one contract's lifecycle; the library owns everything generic.
//
// Hard rule, enforced not suggested: loopback only. This library refuses any endpoint that is
// not 127.0.0.1, so no scenario written on top of it can ever storm a public network.
import { SuiClient } from "@mysten/sui/client";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const LOOPBACK = /^https?:\/\/127\.0\.0\.1[:/]/;

export function makeStage({ rpc = "http://127.0.0.1:9000", faucet = "http://127.0.0.1:9123" } = {}) {
  if (!LOOPBACK.test(rpc) || !LOOPBACK.test(faucet)) {
    throw new Error(`sui-stage is loopback-only; refusing ${rpc} ${faucet}`);
  }
  const client = new SuiClient({ url: rpc });
  const phases = [];
  const t0 = Date.now();

  const gasOf = (fx) => {
    const g = fx.effects.gasUsed;
    return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
  };

  const note = (phase, ms, gas, extra = "") => {
    phases.push({ phase, ms, gas: gas?.toString() ?? "-", extra });
    console.log(`   ${phase}: ${ms}ms gas=${gas ?? "-"} ${extra}`);
  };

  /** Confirmed path — for lifecycle steps whose objects later transactions read. */
  async function runTx(kp, tx) {
    const fx = await client.signAndExecuteTransaction({
      signer: kp, transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });
    if (fx.effects.status.status !== "success") {
      throw new Error(`tx failed: ${JSON.stringify(fx.effects.status)}`);
    }
    await client.waitForTransaction({ digest: fx.digest });
    return fx;
  }

  /** Fast path — for storm transactions between independent actors. Effects are checked, the
   *  indexing wait is skipped; pair with `waitVisible` before any read of aggregate state. */
  async function runTxFast(kp, tx) {
    const fx = await client.signAndExecuteTransaction({
      signer: kp, transaction: tx, options: { showEffects: true },
    });
    if (fx.effects.status.status !== "success") {
      throw new Error(`tx failed: ${JSON.stringify(fx.effects.status)}`);
    }
    return fx;
  }

  /** Faucet-feed one whale, then cut N wallets from it in 400-transfer PTBs. Reads the whale's
   *  real balance rather than assuming the faucet's payout size. */
  async function fundActors(count, perActorMist) {
    const actors = Array.from({ length: count }, () => new Ed25519Keypair());
    const whale = new Ed25519Keypair();
    const need = perActorMist * BigInt(count) + 1_000_000_000n;
    let bal = 0n;
    while (bal < need) {
      await requestSuiFromFaucetV2({ host: faucet, recipient: whale.toSuiAddress() });
      bal = BigInt((await client.getBalance({ owner: whale.toSuiAddress() })).totalBalance);
    }
    for (let i = 0; i < actors.length; i += 400) {
      const batch = actors.slice(i, i + 400);
      const tx = new Transaction();
      const cuts = tx.splitCoins(tx.gas, batch.map(() => tx.pure.u64(perActorMist)));
      batch.forEach((kp, j) => tx.transferObjects([cuts[j]], kp.toSuiAddress()));
      await runTx(whale, tx);
    }
    return actors;
  }

  /** The storm: every actor runs `buildTx(actor, index)` once, `workers` in flight.
   *  Returns { first, last } effects for gas-growth comparison. */
  async function storm(actors, buildTx, { workers = 96 } = {}) {
    let i = 0, first = null, last = null;
    const worker = async () => {
      while (i < actors.length) {
        const mine = i++;
        const fx = await runTxFast(actors[mine], await buildTx(actors[mine], mine));
        if (mine === 0) first = fx;
        if (mine === actors.length - 1) last = fx;
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, actors.length) }, worker));
    return { first, last };
  }

  /** Checkpoint-lag gate: the fast path outruns the fullnode's checkpointed view, and any
   *  dry-run or read of aggregate state sees stale data until it catches up. Wait for a
   *  predicate over the object's visible fields before proceeding. */
  async function waitVisible(objectId, predicate, { tries = 60, delayMs = 3000 } = {}) {
    for (let t = 0; t < tries; t++) {
      const st = await client.getObject({ id: objectId, options: { showContent: true } });
      if (predicate(st.data?.content?.fields ?? {})) return;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`waitVisible: predicate never satisfied for ${objectId}`);
  }

  function report(title, verdictLines = []) {
    return [
      `# ${title}`,
      ``,
      `Date: ${new Date().toISOString()} · total wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      ``,
      `| phase | wall ms | gas (MIST) | notes |`,
      `|---|---|---|---|`,
      ...phases.map((p) => `| ${p.phase} | ${p.ms} | ${p.gas} | ${p.extra} |`),
      ``,
      ...verdictLines,
      ``,
    ].join("\n");
  }

  return { client, gasOf, note, runTx, runTxFast, fundActors, storm, waitVisible, report };
}
