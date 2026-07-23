package com.firstnational.deposits;

import java.math.BigDecimal;
import static java.math.RoundingMode.HALF_EVEN;

final class AnnualPercentageYieldCalculator {
    private static final BigDecimal ONE = BigDecimal.ONE;

    /** Reg DD / Truth-in-Savings APY (12 CFR 1030, App. A). */
    BigDecimal annualPercentageYield(Rate dividend, int days) {
        return ONE.add(dividend.over(days)).pow(days)
                  .subtract(ONE).setScale(2, HALF_EVEN);
    }
}

record Rate(BigDecimal value) {
    BigDecimal over(int days) { return value.divide(new BigDecimal(days)); }
}
