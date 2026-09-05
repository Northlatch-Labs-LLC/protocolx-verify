// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// production-guards — the mirror image of annotation-forms.move.
//
// Every assert here is a real guard on a real code path. Excluding any one of
// them as "test-internal" would be the failure that silently shrinks our own
// numbers: a guard nobody tests would stop being counted as a guard nobody
// tests. The single `#[test]` function in the middle is the interleaving case —
// its region must close on its own brace and swallow neither neighbour.
module fixture::production_guards {

    const ENotAuthorised: u64 = 1;
    const EOverflow: u64 = 2;

    public fun assert_positive(v: u64) {
        assert!(v > 0, EOverflow);
    }

    public fun assert_bounded(v: u64, hi: u64) {
        assert!(v <= hi, EOverflow);
    }

    // The class the `);` predicate cannot see: the assert is the last
    // expression of the function, so Move permits no trailing semicolon.
    public fun assert_authorised_witness(ok: bool) {
        assert!(ok, ENotAuthorised)
    }

    // A guard whose condition spans three lines.
    public fun assert_within(v: u64, lo: u64, hi: u64) {
        assert!(
            v >= lo && v <= hi,
            EOverflow
        );
    }

    // The interleaving case.
    #[test]
    fun bounded_test() {
        assert!(1 <= 2, EOverflow);
    }

    public fun assert_not_zero(v: u64) {
        assert!(v != 0, EOverflow);
    }

    // An `entry fun` guard, with no annotation of any kind.
    entry fun assert_even(v: u64) {
        assert!(v % 2 == 0, EOverflow);
    }

    // Asserts in a line comment, a block comment and a byte string are not
    // code, so they are neither production guards nor phantoms.
    public fun label(): vector<u8> {
        // assert!(fake_line_comment, EOverflow);
        /* assert!(fake_block_comment, EOverflow); */
        b"assert!(fake_string_literal, EOverflow);"
    }
}
