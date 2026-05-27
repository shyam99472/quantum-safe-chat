export const NO_HEAL = "NO_HEAL";
export const SCHEDULED_CLASSICAL_HEAL = "TREE_HEAL_CLASSICAL";
export const SCHEDULED_PQ_BATCH_HEAL = "TREE_HEAL_PQ_BATCH";

export function recommendHealing({
    groupSize = 0,
    messagesSinceLastHeal = 0,
    messagesSinceLastPqHeal = 0,
    msSinceLastHeal = 0,
    msSinceLastPqHeal = 0,
    membershipChanges = 0,
    suspectedCompromise = false,
    lastHealMode = null
} = {}) {
    if (suspectedCompromise) {
        return {
            action: SCHEDULED_PQ_BATCH_HEAL,
            reason: "Suspicious activity detected; forcing PQ healing for PCS recovery."
        };
    }

    if (membershipChanges > 0) {
        return {
            action: SCHEDULED_PQ_BATCH_HEAL,
            reason: "Membership changed; forcing PQ healing to refresh the group path secrets."
        };
    }

    if (groupSize >= 8 && messagesSinceLastPqHeal >= 10) {
        return {
            action: SCHEDULED_PQ_BATCH_HEAL,
            reason: "Large-group traffic threshold reached; escalating to PQ batch healing."
        };
    }

    if (msSinceLastPqHeal >= 5 * 60 * 1000) {
        return {
            action: SCHEDULED_PQ_BATCH_HEAL,
            reason: "PQ refresh interval exceeded; performing periodic PQ healing."
        };
    }

    if (messagesSinceLastPqHeal >= 10) {
        return {
            action: SCHEDULED_PQ_BATCH_HEAL,
            reason: "Message-volume threshold since last PQ heal reached; escalating to PQ batch healing."
        };
    }

    if (lastHealMode !== SCHEDULED_CLASSICAL_HEAL && messagesSinceLastHeal >= 4) {
        return {
            action: SCHEDULED_CLASSICAL_HEAL,
            reason: "Recent message volume crossed the lightweight healing threshold."
        };
    }

    if (lastHealMode !== SCHEDULED_CLASSICAL_HEAL && msSinceLastHeal >= 90 * 1000 && messagesSinceLastHeal >= 1) {
        return {
            action: SCHEDULED_CLASSICAL_HEAL,
            reason: "Active session exceeded the classical refresh interval."
        };
    }

    return {
        action: NO_HEAL,
        reason: "Scheduler monitoring traffic."
    };
}
