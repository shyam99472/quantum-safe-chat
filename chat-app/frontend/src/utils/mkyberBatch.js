const DEFAULT_BATCH_SIZE = 2;

function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

export function buildPqBatchPlan(memberIds, adminId, treeKemState, batchSize = DEFAULT_BATCH_SIZE) {
    const recipients = memberIds.filter((memberId) => memberId?.toString() !== adminId?.toString());
    const batches = chunk(recipients, Math.max(1, batchSize)).map((batchMembers, index) => {
        const batchId = `batch-${index + 1}`;
        const pathCoverage = batchMembers.map((memberId) => ({
            memberId,
            directPath: treeKemState?.getDirectPath(memberId) || [],
            coPath: treeKemState?.getCoPath(memberId) || []
        }));

        return {
            batchId,
            size: batchMembers.length,
            members: batchMembers,
            pathCoverage
        };
    });

    const recipientToBatch = {};
    for (const batch of batches) {
        for (const memberId of batch.members) {
            recipientToBatch[memberId] = batch.batchId;
        }
    }

    return {
        batchStrategy: "mkyber-subgroup-batching",
        batchSize: Math.max(1, batchSize),
        totalRecipients: recipients.length,
        totalBatches: batches.length,
        batches,
        recipientToBatch
    };
}
