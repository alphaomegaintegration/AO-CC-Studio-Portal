package com.firstnational.deposits;

final class AchReturnHandler {
    // INFERRED: R10 -> manual review (no explicit legacy branch)
    void onReturn(AchReturn r) {
        if (r.code() == ReturnCode.R10) {
            reviewQueue().enqueue(r);   // awaiting SME confirmation
        }
    }
    ReviewQueue reviewQueue() { return new ReviewQueue(); }
}

record AchReturn(ReturnCode code) {}
enum ReturnCode { R01, R10, OTHER }
final class ReviewQueue { void enqueue(AchReturn r) {} }
