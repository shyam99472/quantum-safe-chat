function buildNodeId(level, index) {
    return `L${level}:N${index}`;
}

function buildLeafNodes(members) {
    return members.map((memberId, index) => ({
        nodeId: buildNodeId(0, index),
        level: 0,
        index,
        memberId,
        leftChild: null,
        rightChild: null,
        parentId: null,
        occupied: true
    }));
}

function buildParentLayer(childLayer, level) {
    const parentLayer = [];

    for (let index = 0; index < childLayer.length; index += 2) {
        const leftChild = childLayer[index];
        const rightChild = childLayer[index + 1] || null;
        const parentIndex = Math.floor(index / 2);
        const parentNode = {
            nodeId: buildNodeId(level, parentIndex),
            level,
            index: parentIndex,
            memberId: null,
            leftChild: leftChild?.nodeId || null,
            rightChild: rightChild?.nodeId || null,
            parentId: null,
            occupied: Boolean(leftChild || rightChild)
        };

        if (leftChild) {
            leftChild.parentId = parentNode.nodeId;
        }
        if (rightChild) {
            rightChild.parentId = parentNode.nodeId;
        }

        parentLayer.push(parentNode);
    }

    return parentLayer;
}

function buildTreeLayers(members) {
    const layers = [];
    let currentLayer = buildLeafNodes(members);
    layers.push(currentLayer);

    let level = 1;
    while (currentLayer.length > 1) {
        currentLayer = buildParentLayer(currentLayer, level);
        layers.push(currentLayer);
        level += 1;
    }

    return layers;
}

export class TreeKemState {
    constructor({ groupId, epoch, members, layers }) {
        this.groupId = groupId;
        this.epoch = epoch;
        this.members = [...members];
        this.layers = layers;
        this.nodeMap = new Map();

        for (const layer of layers) {
            for (const node of layer) {
                this.nodeMap.set(node.nodeId, node);
            }
        }
    }

    static createInitial(groupId, members, epoch = 1) {
        const layers = buildTreeLayers(members);
        return new TreeKemState({
            groupId,
            epoch,
            members,
            layers
        });
    }

    static fromSnapshot(snapshot) {
        return new TreeKemState({
            groupId: snapshot.groupId,
            epoch: snapshot.epoch,
            members: snapshot.members || [],
            layers: (snapshot.layers || []).map((layer) => layer.map((node) => ({ ...node })))
        });
    }

    serialize() {
        return {
            groupId: this.groupId,
            epoch: this.epoch,
            members: [...this.members],
            height: this.layers.length,
            width: this.layers[0]?.length || 0,
            layers: this.layers.map((layer) => layer.map((node) => ({ ...node })))
        };
    }

    getLeafIndex(memberId) {
        return this.layers[0]?.findIndex((node) => node.memberId?.toString() === memberId?.toString()) ?? -1;
    }

    getLeafNode(memberId) {
        const leafIndex = this.getLeafIndex(memberId);
        return leafIndex >= 0 ? this.layers[0][leafIndex] : null;
    }

    getDirectPath(memberId) {
        const path = [];
        let currentNode = this.getLeafNode(memberId);

        while (currentNode?.parentId) {
            const parentNode = this.nodeMap.get(currentNode.parentId);
            if (!parentNode) break;
            path.push(parentNode.nodeId);
            currentNode = parentNode;
        }

        return path;
    }

    getCoPath(memberId) {
        const copath = [];
        let currentNode = this.getLeafNode(memberId);

        while (currentNode?.parentId) {
            const parentNode = this.nodeMap.get(currentNode.parentId);
            if (!parentNode) break;

            const siblingId = parentNode.leftChild === currentNode.nodeId
                ? parentNode.rightChild
                : parentNode.leftChild;
            if (siblingId) {
                copath.push(siblingId);
            }

            currentNode = parentNode;
        }

        return copath;
    }

    getRootNode() {
        const topLayer = this.layers[this.layers.length - 1] || [];
        return topLayer[0] || null;
    }

    advanceEpoch(nextMembers = this.members) {
        return TreeKemState.createInitial(this.groupId, nextMembers, this.epoch + 1);
    }
}
