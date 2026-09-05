// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// annotation-forms — every shape of `#[test]` / `#[test_only]` declaration that
// find_test_regions must govern, and the non-test attributes it must not.
//
// An assert inside a test-annotated declaration can never be failed by a test
// run, so a mutation derived from it can never be killed: it scores as a
// surviving mutant and inflates the survivor count in the direction that
// flatters us. Every assert in this file is one of those phantoms except the two
// marked PRODUCTION, which are here to prove the regions close where they should.
//
// production-guards.move holds the mirror image.
module fixture::annotation_forms {

    const ENotAuthorised: u64 = 1;
    const EOutOfRange: u64 = 2;

    // A non-test attribute carrying nested parentheses. Reading this as a test
    // annotation would swallow the production guard below into a test region.
    #[allow(lint(missing_key))]
    struct Store has key {
        id: address,
        value: u64,
    }

    // PRODUCTION. Immediately after a non-test attribute, on purpose.
    public fun assert_in_range(v: u64) {
        assert!(v < 100, EOutOfRange);
    }

    // `#[test_only]` on a `use` declaration: terminated by `;`, no body. A
    // region that brace-matched from here would swallow the next function.
    #[test_only]
    use sui::test_scenario;

    #[test_only]
    use sui::tx_context;

    // `#[test_only]` on a `public fun` with a body.
    #[test_only]
    public fun init_for_testing(v: u64): u64 {
        assert!(v > 0, ENotAuthorised);
        v
    }

    // `#[test_only]` on a bare `fun`.
    #[test_only]
    fun shift_decimal(v: u64): u64 {
        assert!(v < 64, EOutOfRange);
        v << 1
    }

    // `#[test]` on a bare `fun`, two asserts in one body.
    #[test]
    fun range_test() {
        let v = 5;
        assert!(v < 100, EOutOfRange);
        assert!(v > 0, ENotAuthorised);
    }

    // `#[test]` on a `public fun`.
    #[test]
    public fun public_range_test() {
        assert!(1 < 2, EOutOfRange);
    }

    // Two attributes in ONE bracket.
    #[test, expected_failure]
    fun out_of_range_aborts() {
        assert!(200 < 100, EOutOfRange);
    }

    // Two attributes STACKED, the test attribute first.
    #[test]
    #[expected_failure(abort_code = ENotAuthorised)]
    fun unauthorised_aborts() {
        assert!(0 > 0, ENotAuthorised);
    }

    // Stacked the other way round: the test attribute is second, and the first
    // one carries parentheses of its own.
    #[expected_failure(abort_code = EOutOfRange)]
    #[test]
    fun stacked_test_attribute_last() {
        assert!(200 < 100, EOutOfRange);
    }

    // `#[test_only]` on `public(package) fun` — a declaration modifier with its
    // own parentheses standing between the annotation and the keyword.
    #[test_only]
    public(package) fun package_helper(v: u64) {
        assert!(v != 0, ENotAuthorised);
    }

    // `#[test_only]` on `entry fun`.
    #[test_only]
    entry fun entry_helper(v: u64) {
        assert!(v != 1, ENotAuthorised);
    }

    // PRODUCTION, after all of the above: every region must have closed.
    public fun assert_authorised(ok: bool) {
        assert!(ok, ENotAuthorised);
    }
}
