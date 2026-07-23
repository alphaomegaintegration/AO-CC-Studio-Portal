package com.firstnational.deposits;

import java.math.BigDecimal;

final class InterestAccrualService {
    private static final BigDecimal DAYS_IN_YEAR = new BigDecimal("365");
    private final AuditPort audit = new AuditPort();

    /** Reg-bound daily accrual; dormant accounts are suppressed. */
    BigDecimal accrueDaily(Account account, MoneyRate dailyRate) {
        BigDecimal principal = account.collectedBalance();

        if (account.status() == AccountStatus.DORMANT) {
            audit.suppressed(account, Reason.DORMANT);
            return BigDecimal.ZERO;
        }
        return principal.multiply(dailyRate.value())
                        .divide(DAYS_IN_YEAR);
    }
}

record Account(AccountStatus status, BigDecimal collectedBalance) {}
record MoneyRate(BigDecimal value) {}
enum AccountStatus { ACTIVE, DORMANT }
enum Reason { DORMANT }
final class AuditPort { void suppressed(Account account, Reason reason) {} }
