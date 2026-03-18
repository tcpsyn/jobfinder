// === Network View ===
async function renderNetwork(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading contacts...</span></div>`;

    try {
        const data = await api.request('GET', '/api/contacts');
        const contacts = data.contacts || [];

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Network</h1>
                <button class="btn btn-primary btn-sm" id="add-contact-btn">Add Contact</button>
            </div>
            <div style="margin-bottom:16px">
                <input type="text" class="search-input" id="contact-search" placeholder="Search contacts..." style="width:100%;max-width:400px">
            </div>
            <div id="contacts-list">
                ${contacts.length === 0 ? `
                    <div class="empty-state">
                        <div class="empty-state-icon">&#128101;</div>
                        <div class="empty-state-title">No contacts yet</div>
                        <div class="empty-state-desc">Add contacts to track your professional network and link them to job applications.</div>
                    </div>
                ` : `
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                        ${contacts.map(c => `
                            <div class="card card-interactive contact-card" style="padding:16px;cursor:pointer" data-contact-id="${c.id}" data-name="${escapeHtml(c.name).toLowerCase()}" data-company="${escapeHtml(c.company || '').toLowerCase()}">
                                <div style="font-weight:600;font-size:0.9375rem">${escapeHtml(c.name)}</div>
                                ${c.role ? `<div style="font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(c.role)}</div>` : ''}
                                ${c.company ? `<div style="font-size:0.8125rem;color:var(--text-tertiary)">${escapeHtml(c.company)}</div>` : ''}
                                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                                    ${c.email ? `<span style="font-size:0.75rem;color:var(--accent)">${escapeHtml(c.email)}</span>` : ''}
                                    ${c.linkedin_url ? `<a href="${sanitizeUrl(c.linkedin_url)}" target="_blank" rel="noopener noreferrer" style="font-size:0.75rem">LinkedIn</a>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>
            <div id="contact-detail-panel" style="display:none"></div>
            <div id="contact-form-panel" style="display:none">
                <div class="card" style="padding:24px;margin-top:16px">
                    <h3 style="font-size:1rem;font-weight:600;margin-bottom:12px" id="contact-form-title">Add Contact</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Name *</label><input type="text" class="search-input" id="contact-name" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Email</label><input type="email" class="search-input" id="contact-email" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Company</label><input type="text" class="search-input" id="contact-company" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Role</label><input type="text" class="search-input" id="contact-role" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Phone</label><input type="text" class="search-input" id="contact-phone" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">LinkedIn URL</label><input type="text" class="search-input" id="contact-linkedin" style="width:100%"></div>
                    </div>
                    <div style="margin-top:12px"><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Notes</label><textarea class="textarea-styled textarea-notes" id="contact-notes"></textarea></div>
                    <div style="display:flex;gap:8px;margin-top:12px">
                        <button class="btn btn-primary btn-sm" id="contact-save-btn">Save</button>
                        <button class="btn btn-secondary btn-sm" id="contact-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
        `;

        let editingContactId = null;

        // Search filter
        document.getElementById('contact-search').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            document.querySelectorAll('.contact-card').forEach(card => {
                const name = card.dataset.name || '';
                const company = card.dataset.company || '';
                card.style.display = (name.includes(q) || company.includes(q)) ? '' : 'none';
            });
        });

        // Add contact
        document.getElementById('add-contact-btn').addEventListener('click', () => {
            editingContactId = null;
            document.getElementById('contact-form-title').textContent = 'Add Contact';
            ['contact-name', 'contact-email', 'contact-company', 'contact-role', 'contact-phone', 'contact-linkedin', 'contact-notes'].forEach(id => { document.getElementById(id).value = ''; });
            document.getElementById('contact-form-panel').style.display = '';
            document.getElementById('contact-detail-panel').style.display = 'none';
        });

        document.getElementById('contact-cancel-btn').addEventListener('click', () => {
            document.getElementById('contact-form-panel').style.display = 'none';
        });

        document.getElementById('contact-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('contact-name').value.trim();
            if (!name) { showToast('Name is required', 'error'); return; }
            const body = { name, email: document.getElementById('contact-email').value.trim(), company: document.getElementById('contact-company').value.trim(), role: document.getElementById('contact-role').value.trim(), phone: document.getElementById('contact-phone').value.trim(), linkedin_url: document.getElementById('contact-linkedin').value.trim(), notes: document.getElementById('contact-notes').value };
            try {
                if (editingContactId) {
                    await api.request('PUT', `/api/contacts/${editingContactId}`, body);
                    showToast('Contact updated', 'success');
                } else {
                    await api.request('POST', '/api/contacts', body);
                    showToast('Contact added', 'success');
                }
                await renderNetwork(container);
            } catch (err) { showToast(err.message, 'error'); }
        });

        // Click contact card to see detail + interactions
        container.querySelectorAll('.contact-card').forEach(card => {
            card.addEventListener('click', async () => {
                const contactId = parseInt(card.dataset.contactId);
                const contact = contacts.find(c => c.id === contactId);
                if (!contact) return;
                document.getElementById('contact-form-panel').style.display = 'none';
                const detailPanel = document.getElementById('contact-detail-panel');
                detailPanel.style.display = '';
                detailPanel.innerHTML = '<div class="loading-container"><span class="spinner"></span></div>';

                try {
                    const intData = await api.request('GET', `/api/contacts/${contactId}/interactions`);
                    const interactions = intData.interactions || [];
                    detailPanel.innerHTML = `
                        <div class="card" style="padding:24px;margin-top:16px">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
                                <div>
                                    <h2 style="font-size:1.25rem;font-weight:700">${escapeHtml(contact.name)}</h2>
                                    ${contact.role ? `<div style="color:var(--text-secondary)">${escapeHtml(contact.role)}${contact.company ? ` at ${escapeHtml(contact.company)}` : ''}</div>` : ''}
                                    <div style="display:flex;gap:12px;margin-top:8px;font-size:0.8125rem">
                                        ${contact.email ? `<span>${escapeHtml(contact.email)}</span>` : ''}
                                        ${contact.phone ? `<span>${escapeHtml(contact.phone)}</span>` : ''}
                                        ${contact.linkedin_url ? `<a href="${sanitizeUrl(contact.linkedin_url)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : ''}
                                    </div>
                                    ${contact.notes ? `<div style="margin-top:8px;font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(contact.notes)}</div>` : ''}
                                </div>
                                <div style="display:flex;gap:6px">
                                    <button class="btn btn-secondary btn-sm" id="edit-contact-btn">Edit</button>
                                    <button class="btn btn-danger btn-sm" id="delete-contact-btn">Delete</button>
                                </div>
                            </div>
                            <h3 style="font-size:0.875rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Interactions</h3>
                            <div style="display:flex;gap:6px;margin-bottom:12px">
                                <input type="text" class="search-input" id="interaction-notes" placeholder="Add interaction note..." style="flex:1">
                                <select class="filter-select" id="interaction-type" style="width:auto">
                                    <option value="note">Note</option>
                                    <option value="email">Email</option>
                                    <option value="call">Call</option>
                                    <option value="meeting">Meeting</option>
                                    <option value="linkedin">LinkedIn</option>
                                </select>
                                <button class="btn btn-primary btn-sm" id="add-interaction-btn">Add</button>
                            </div>
                            <div class="timeline">
                                ${interactions.length === 0 ? '<div style="font-size:0.875rem;color:var(--text-tertiary);padding:8px 0">No interactions yet.</div>' :
                                interactions.map(i => `
                                    <div class="timeline-event">
                                        <div>
                                            <div class="timeline-detail">${escapeHtml(i.notes || i.type)}</div>
                                            <div class="timeline-time">${escapeHtml(i.type)} &middot; ${formatDate(i.date || i.created_at)}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;

                    document.getElementById('edit-contact-btn').addEventListener('click', () => {
                        editingContactId = contactId;
                        document.getElementById('contact-form-title').textContent = 'Edit Contact';
                        document.getElementById('contact-name').value = contact.name || '';
                        document.getElementById('contact-email').value = contact.email || '';
                        document.getElementById('contact-company').value = contact.company || '';
                        document.getElementById('contact-role').value = contact.role || '';
                        document.getElementById('contact-phone').value = contact.phone || '';
                        document.getElementById('contact-linkedin').value = contact.linkedin_url || '';
                        document.getElementById('contact-notes').value = contact.notes || '';
                        document.getElementById('contact-form-panel').style.display = '';
                        detailPanel.style.display = 'none';
                    });

                    document.getElementById('delete-contact-btn').addEventListener('click', async () => {
                        const ok = await showModal({
                            title: 'Delete Contact',
                            message: `Delete ${contact.name}?`,
                            confirmText: 'Delete',
                            danger: true,
                        });
                        if (!ok) return;
                        try {
                            await api.request('DELETE', `/api/contacts/${contactId}`);
                            showToast('Contact deleted', 'success');
                            await renderNetwork(container);
                        } catch (err) { showToast(err.message, 'error'); }
                    });

                    document.getElementById('add-interaction-btn').addEventListener('click', async () => {
                        const notes = document.getElementById('interaction-notes').value.trim();
                        if (!notes) return;
                        try {
                            await api.request('POST', `/api/contacts/${contactId}/interactions`, {
                                type: document.getElementById('interaction-type').value,
                                notes,
                            });
                            showToast('Interaction added', 'success');
                            card.click(); // refresh detail
                        } catch (err) { showToast(err.message, 'error'); }
                    });
                } catch (err) {
                    detailPanel.innerHTML = `<div style="color:var(--danger);padding:16px">${escapeHtml(err.message)}</div>`;
                }
            });
        });
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load contacts</div></div>`;
    }
}
