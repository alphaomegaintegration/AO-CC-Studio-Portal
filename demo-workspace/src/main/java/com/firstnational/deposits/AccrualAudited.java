package com.firstnational.deposits;

import java.time.Instant;
import java.math.BigDecimal;

/** Net-new: emitted when an accrual is posted (Contract v1.2). */
public record AccrualAudited(
        AccountId account,
        Money amount,
        Instant postedAt) implements DomainEvent {}

record AccountId(String value) {}
record Money(BigDecimal amount) {}
interface DomainEvent {}
