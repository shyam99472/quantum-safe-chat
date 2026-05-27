const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('C:/Users/ponug/OneDrive/Desktop/SDP/chat-app/frontend/src/pages/Chat.jsx');
let content = fs.readFileSync(targetFile, 'utf8');

// 1. Imports
content = content.replace(
    "import { sessionManager } from '../utils/sessionManager';",
    "import { sessionManager } from '../utils/sessionManager';\nimport { groupSessionManager, MAX_GROUP_SIZE } from '../utils/groupSessionManager';"
);

// 2. Add Group State
content = content.replace(
    "const [isMobileListView, setIsMobileListView] = useState(true);",
    `const [isMobileListView, setIsMobileListView] = useState(true);
    const [groups, setGroups] = useState([]);
    const [selectedGroup, setSelectedGroup] = useState(null);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [selectedMembers, setSelectedMembers] = useState([]);
    const selectedGroupRef = useRef(selectedGroup);
    useEffect(() => { selectedGroupRef.current = selectedGroup; }, [selectedGroup]);`
);

// 3. Update Fetching
content = content.replace(
    /const fetchUsers = async \(\) => \{[\s\S]*?fetchUsers\(\);/,
    `const fetchData = async () => {
            try {
                const res = await api.get('/auth/users');
                setUsers(res.data.filter(u => u._id !== user._id));
                const gRes = await api.get('/groups');
                setGroups(gRes.data);
            } catch (err) {
                console.error('Failed to fetch data', err);
            }
        };
        fetchData();`
);

// 4. Update Socket Listeners specifically for Groups
content = content.replace(
    "socket.on('receive_message', handleReceiveMessage);",
    `socket.on('receive_message', handleReceiveMessage);

            const handleReceiveGroupMessage = async (message) => {
                const currentlySelectedGroup = selectedGroupRef.current;
                const myId = user._id?.toString();

                if (message.senderId === myId) return; // Self-sender protection

                if (message.text === '[GROUP_KEY_UPDATE]') {
                    try {
                        const encryptedKeys = message.payload.encryptedKeys;
                        const myEncryptedKeyObj = encryptedKeys[myId];
                        if (!myEncryptedKeyObj) return;

                        const adminPubKey = message.payload.adminPublicKey;
                        const wrapKey = await deriveAESKey(privateKey, adminPubKey, null);
                        const decText = await decryptMessage(myEncryptedKeyObj.ciphertext, wrapKey, myEncryptedKeyObj.nonce);
                        
                        // Parse raw key (assuming it was encoded as comma-separated uint8 array string)
                        const newRootKeyRaw = new Uint8Array(decText.split(',').map(Number)).buffer;
                        const groupMembers = message.payload.members || [];
                        
                        // Local rekey / init
                        if (groupSessionManager.groups.has(message.groupId)) {
                            // Rekey
                            await groupSessionManager.rekeyGroup(message.groupId, newRootKeyRaw, groupMembers);
                        } else {
                            // Init
                            await groupSessionManager.initGroup(message.groupId, message.senderId, groupMembers, newRootKeyRaw);
                        }
                        
                        const group = groupSessionManager.groups.get(message.groupId);
                        group.groupEpoch = message.groupEpoch;
                        group.groupMembershipVersion = message.groupMembershipVersion;

                        await groupSessionManager.setupLocalSender(message.groupId, myId);
                        for(let mId of groupMembers) {
                            if (mId !== myId) await groupSessionManager.getOrInitReceiveRatchet(message.groupId, mId);
                        }

                        socket.emit('group_key_update_ack', {
                            groupId: message.groupId,
                            groupEpoch: message.groupEpoch,
                            userId: myId
                        });
                        console.log('Group synced and ACKed');
                    } catch (err) {
                        console.error('Failed to process GROUP_KEY_UPDATE', err);
                    }
                    return;
                }

                if (currentlySelectedGroup && message.groupId === currentlySelectedGroup.groupId) {
                     if (message.isEncrypted) {
                         try {
                              const envelope = {
                                  groupId: message.groupId,
                                  groupEpoch: message.groupEpoch,
                                  groupMembershipVersion: message.groupMembershipVersion,
                                  senderId: message.senderId,
                                  messageIndex: message.messageIndex
                              };
                              const decText = await groupSessionManager.decryptGroupMessage(
                                  message.groupId, message.senderId, message.text, message.nonce, envelope
                              );
                              setMessages(prev => [...prev, { ...message, text: decText }]);
                         } catch (err) {
                              setMessages(prev => [...prev, { ...message, text: '[Decryption Failed]' }]);
                         }
                     } else {
                         setMessages(prev => [...prev, message]);
                     }
                }
            };

            const handleReceiveGroupAck = async ({ groupId, groupEpoch, userId }) => {
                const synced = await groupSessionManager.ackRekey(groupId, userId);
                if (synced) console.log("Group fully synced!");
            };

            socket.on('receive_group_message', handleReceiveGroupMessage);
            socket.on('receive_group_key_update_ack', handleReceiveGroupAck);
            socket.on('group_created', (newGroup) => { setGroups(prev => [...prev, newGroup]); });`
);

// 5. Cleanup hooks
content = content.replace(
    "socket.off('receive_message', handleReceiveMessage);",
    "socket.off('receive_message', handleReceiveMessage);\n                socket.off('receive_group_message');\n                socket.off('receive_group_key_update_ack');\n                socket.off('group_created');"
);

// 6. Sidebar Render Updates
content = content.replace(
    /<div className="user-list">[\s\S]*?<\/div>\s*<\/div>\s*\{\/\* Chat Area \*\/\}/,
    `<div className="user-list" style={{ overflowY: 'auto' }}>
                    <div style={{ padding: '10px' }}>
                        <h4 style={{ margin: '10px 0', color: 'var(--wa-text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
                            Groups
                            <button onClick={() => setShowGroupModal(true)} style={{ background: 'none', border: 'none', color: 'var(--wa-primary-color)', cursor: 'pointer', fontSize: '18px' }}>+</button>
                        </h4>
                        {groups.map(g => (
                            <div key={g.groupId} className={\`user-list-item \${selectedGroup?.groupId === g.groupId ? 'active' : ''}\`} onClick={() => handleGroupSelect(g)}>
                                <div className="avatar" style={{ backgroundColor: '#128C7E' }}>{g.name.charAt(0).toUpperCase()}</div>
                                <div className="user-info">
                                    <div className="user-name">{g.name}</div>
                                </div>
                            </div>
                        ))}
                        <h4 style={{ margin: '15px 0 10px', color: 'var(--wa-text-secondary)' }}>Users</h4>
                        {users.map(u => (
                            <div key={u._id} className={\`user-list-item \${selectedUser?._id === u._id && !selectedGroup ? 'active' : ''}\`} onClick={() => handleUserSelect(u)}>
                                <div className="avatar">{u.username.charAt(0).toUpperCase()}</div>
                                <div className="user-info">
                                    <div className="user-name">{u.username}</div>
                                    <div className="user-status">{u.isOnline ? <span style={{ color: 'green' }}>Online</span> : 'Offline'}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {showGroupModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', width: '400px', maxWidth: '90%' }}>
                        <h2>Create Group</h2>
                        <input type="text" placeholder="Group Name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} style={{ width: '100%', padding: '10px', margin: '10px 0', borderRadius: '4px', border: '1px solid #ccc' }} />
                        <h4 style={{ margin: '10px 0' }}>Select Members</h4>
                        <div style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #eee', padding: '5px' }}>
                            {users.map(u => (
                                <div key={u._id} style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
                                    <input type="checkbox" id={\`chk-\${u._id}\`} checked={selectedMembers.includes(u._id)} onChange={(e) => {
                                        if (e.target.checked) setSelectedMembers(prev => [...prev, u._id]);
                                        else setSelectedMembers(prev => prev.filter(id => id !== u._id));
                                    }} style={{ marginRight: '10px' }} />
                                    <label htmlFor={\`chk-\${u._id}\`}>{u.username}</label>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px', gap: '10px' }}>
                            <button onClick={() => setShowGroupModal(false)} style={{ padding: '8px 15px', border: 'none', backgroundColor: '#ccc', borderRadius: '4px' }}>Cancel</button>
                            <button onClick={handleCreateGroup} style={{ padding: '8px 15px', border: 'none', backgroundColor: 'var(--wa-primary-color)', color: '#fff', borderRadius: '4px' }}>Create</button>
                        </div>
                    </div>
                </div>
            )}
            {/* Chat Area */}`
);

fs.writeFileSync(targetFile, content);
console.log('Patched UI effectively');
