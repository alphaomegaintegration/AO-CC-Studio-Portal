package com.firstnational.deposits;

import java.math.BigDecimal;

final class LedgerPostingAdapter {
    // Allowed-change region: Contract v1.1 - target adapter boundary.
    void post(AccountId account, BigDecimal amount) {
        // Implementation intentionally differs from legacy file IO.
        // Contract conformance is required when posting amounts change.
    }
}
