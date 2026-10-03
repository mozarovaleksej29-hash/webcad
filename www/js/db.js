// js/db.js — Локальная база данных (IndexedDB)

window.WebCAD_DB = (function() {
    'use strict';
    
    const DB_NAME = 'webcad_db';
    const DB_VERSION = 2;
    let db = null;
    
    function openDB() {
        if (db) return Promise.resolve(db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains('projects')) {
                    const store = database.createObjectStore('projects', {
                        keyPath: 'id', autoIncrement: true
                    });
                    store.createIndex('project_type', 'project_type');
                    store.createIndex('updated_at', 'updated_at');
                    store.createIndex('is_archived', 'is_archived');
                }
                if (!database.objectStoreNames.contains('sketch_drafts')) {
                    const store = database.createObjectStore('sketch_drafts', { keyPath: 'key' });
                    store.createIndex('created_at', 'created_at');
                }
                if (!database.objectStoreNames.contains('history')) {
                    const store = database.createObjectStore('history', {
                        keyPath: 'id', autoIncrement: true
                    });
                    store.createIndex('project_id', 'project_id');
                    store.createIndex('created_at', 'created_at');
                }
            };
            req.onsuccess = () => { db = req.result; resolve(db); };
            req.onerror = () => reject(req.error);
        });
    }
    
    function nowISO() { return new Date().toISOString(); }
    function tx(storeName, mode) { return db.transaction(storeName, mode).objectStore(storeName); }
    function wrapReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    
    // ============================================================
    // ПРОЕКТЫ
    // ============================================================
    async function createProject(name, description, projectType) {
        await openDB();
        const project = {
            name: name || 'Новый проект',
            description: description || '',
            project_type: projectType || '2d',
            objects: null,
            is_archived: false,
            created_at: nowISO(),
            updated_at: nowISO()
        };
        const id = await wrapReq(tx('projects', 'readwrite').add(project));
        return { id, ...project };
    }
    
    async function getProjects() {
        await openDB();
        const all = await wrapReq(tx('projects', 'readonly').getAll());
        return all
            .filter(p => !p.is_archived)
            .filter(p => !p.is_sketch && !p.is_offset_plane)   // ✅ как в PHP
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    
    async function getProject(id) {
        await openDB();
        return await wrapReq(tx('projects', 'readonly').get(Number(id)));
    }
    
    async function updateProject(id, changes) {
        await openDB();
        const store = tx('projects', 'readwrite');
        const existing = await wrapReq(store.get(Number(id)));
        if (!existing) throw new Error('Проект не найден: ' + id);
        const updated = { ...existing, ...changes, id: existing.id, updated_at: nowISO() };
        await wrapReq(store.put(updated));
        return updated;
    }
    
    async function deleteProject(id) {
        await openDB();
        // Удаляем историю
        const histStore = tx('history', 'readwrite');
        const histIdx = histStore.index('project_id');
        const allHist = await wrapReq(histIdx.getAll(Number(id)));
        for (const h of allHist) await wrapReq(histStore.delete(h.id));
        // Удаляем проект
        await wrapReq(tx('projects', 'readwrite').delete(Number(id)));
    }
    
    // ============================================================
    // ЧЕРНОВИКИ ЭСКИЗОВ
    // ============================================================
    async function saveSketchDraft(data) {
        await openDB();
        const key = 'draft_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        await wrapReq(tx('sketch_drafts', 'readwrite').add({
            key, data, created_at: nowISO()
        }));
        return key;
    }
    
    async function getSketchDraft(key) {
        await openDB();
        const draft = await wrapReq(tx('sketch_drafts', 'readonly').get(key));
        return draft ? draft.data : null;
    }
    
    async function deleteSketchDraft(key) {
        await openDB();
        await wrapReq(tx('sketch_drafts', 'readwrite').delete(key));
    }
    
    async function cleanOldDrafts() {
        await openDB();
        const store = tx('sketch_drafts', 'readwrite');
        const all = await wrapReq(store.getAll());
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const d of all) {
            if (new Date(d.created_at).getTime() < weekAgo) {
                await wrapReq(store.delete(d.key));
            }
        }
    }
    
    // ============================================================
    // ИСТОРИЯ
    // ============================================================
    async function pushHistory(projectId, snapshot, actionType) {
        await openDB();
        const store = tx('history', 'readwrite');
        await wrapReq(store.add({
            project_id: Number(projectId),
            snapshot,
            action_type: actionType || 'unknown',
            created_at: nowISO()
        }));
        // Обрезаем до 100 записей
        const idx = store.index('project_id');
        const all = await wrapReq(idx.getAll(Number(projectId)));
        if (all.length > 100) {
            all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            for (const h of all.slice(0, all.length - 100)) {
                await wrapReq(store.delete(h.id));
            }
        }
    }
    
    async function getHistory(projectId, limit) {
        await openDB();
        const idx = tx('history', 'readonly').index('project_id');
        const all = await wrapReq(idx.getAll(Number(projectId)));
        all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return all.slice(0, limit || 20).map(h => h.snapshot);
    }
    
    // ✅ НОВОЕ: удалить самый свежий снимок (для шага undo)
    async function popHistory(projectId) {
        await openDB();
        const store = tx('history', 'readwrite');
        const idx = store.index('project_id');
        const all = await wrapReq(idx.getAll(Number(projectId)));
        if (all.length === 0) return;
        all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        await wrapReq(store.delete(all[0].id));
    }
    
    // ============================================================
    // ЭКСПОРТ / ИМПОРТ
    // ============================================================
    async function exportAll() {
        await openDB();
        const projects = await wrapReq(tx('projects', 'readonly').getAll());
        return { version: DB_VERSION, exported_at: nowISO(), projects };
    }
    
    async function importAll(data) {
        if (!data || !data.projects) throw new Error('Неверный формат');
        await openDB();
        const store = tx('projects', 'readwrite');
        for (const p of data.projects) {
            delete p.id;
            await wrapReq(store.add(p));
        }
    }
    
    return {
        openDB,
        createProject, getProjects, getProject, updateProject, deleteProject,
        saveSketchDraft, getSketchDraft, deleteSketchDraft, cleanOldDrafts,
        pushHistory, getHistory, popHistory,
        exportAll, importAll
    };
})();

console.log('✅ js/db.js загружен');
