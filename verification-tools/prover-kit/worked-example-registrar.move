// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Northlatch Labs LLC
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// Machine-checked proofs of the registrar's money path, for the Sui Prover.
///
/// The test suite exercises hand-picked values; these specs hold for every input in the
/// declared domain. The `requires` lines state that domain honestly: each one mirrors an
/// `assert!` inside the target (which aborts, deliberately, outside it) or a u64 headroom
/// bound (the counter/treasury overflows that only a forged 18-quintillion-mist state could
/// reach). Inside the domain, the prover discharges every `ensures` for all inputs at once.
module projectx_names_specs::registrar_specs;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::sui::SUI;
use projectx_names::registrar_v1::{Self as reg, Registrar, RegistrarCap};

#[spec_only]
use prover::prover::{clone, ensures, requires};

const U64_MAX: u128 = 18_446_744_073_709_551_615;
/// The contract's private VERSION constant. If an upgrade ever bumps it, this line moves too.
const VERSION: u64 = 1;

#[spec(prove, target = projectx_names::registrar_v1::collect_fee)]
fun collect_fee_spec(
    registrar: &mut Registrar,
    payment: Coin<SUI>,
    fee_mist: u64,
    base_amount_mist: u64,
    domain: String,
    years: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<SUI> {
    // The target's own gates — outside these it aborts by design.
    requires(reg::version(registrar) == VERSION);
    requires(!reg::paused(registrar));
    requires(domain.length() > 0);
    requires(years > 0);
    requires(payment.value() >= fee_mist);
    // Band arithmetic headroom FIRST — the band expression below multiplies, and this is the
    // bound (enforced on every real object by set_fee_usd) that keeps the product inside u64.
    requires(reg::fee_usd_micros(registrar) <= reg::max_fee_usd_micros());
    // The fee band, when a fee is charged at all.
    requires(
        reg::fee_usd_micros(registrar) == 0 ||
        (fee_mist >= reg::fee_usd_micros(registrar) * reg::min_mist_per_usd_micro() &&
         fee_mist <= reg::fee_usd_micros(registrar) * reg::max_mist_per_usd_micro())
    );
    // u64 headroom for the accumulators.
    requires((reg::treasury_mist(registrar) as u128) + (fee_mist as u128) <= U64_MAX);
    requires((reg::gross_mist(registrar) as u128) + (fee_mist as u128) <= U64_MAX);
    requires((reg::sales(registrar) as u128) + 1 <= U64_MAX);

    let old = clone!(registrar);
    let paid = payment.value();

    let change = reg::collect_fee(
        registrar, payment, fee_mist, base_amount_mist, domain, years, clock, ctx,
    );

    // Conservation: every mist of the payment is either in the treasury or returned.
    ensures(
        (old.treasury_mist() as u128) + (paid as u128) ==
        (registrar.treasury_mist() as u128) + (change.value() as u128)
    );
    // A registrar priced at zero takes nothing, whatever the caller passes.
    ensures(old.fee_usd_micros() != 0 || registrar.treasury_mist() == old.treasury_mist());
    // The treasury never shrinks on a sale, and the counter moves by exactly one.
    ensures(registrar.treasury_mist() >= old.treasury_mist());
    ensures(registrar.sales() == old.sales() + 1);

    change
}

#[spec(prove, target = projectx_names::registrar_v1::withdraw)]
fun withdraw_spec(
    registrar: &mut Registrar,
    cap: &RegistrarCap,
    amount_mist: u64,
    ctx: &mut TxContext,
): Coin<SUI> {
    requires(reg::cap_registrar_for_testing(cap) == object::id(registrar));
    requires(reg::version(registrar) == VERSION);
    requires(amount_mist <= reg::treasury_mist(registrar));

    let old = clone!(registrar);

    let out = reg::withdraw(registrar, cap, amount_mist, ctx);

    // The coin handed out is exactly what was asked, and the treasury shrinks by exactly that.
    ensures(out.value() == amount_mist);
    ensures(
        (old.treasury_mist() as u128) ==
        (registrar.treasury_mist() as u128) + (amount_mist as u128)
    );

    out
}
