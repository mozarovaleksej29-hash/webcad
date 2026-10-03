// js/php-shim.js — эмулирует PHP API через IndexedDB
// Перехватывает fetch('api/projects.php'), fetch('api/sketch-data.php'), fetch('api/history.php')

(function() {
    'use strict';
    
    const originalFetch = window.fetch.bind(window);
    const DB = window.WebCAD_DB;
    
    if (!DB) {
        console.error('❌ php-shim: сначала подключите js/db.js');
        return;
    }
    
    window.fetch = async function(url, options) {
        options = options || {};
        const method = (options.method || 'GET').toUpperCase();
        
        let urlStr = typeof url === 'string' ? url : url.url;
        const urlObj = new URL(urlStr, window.location.href);
        const path = urlObj.pathname;
        
        // api/projects.php
        if (path.endsWith('api/projects.php')) {
            // ✅ Обработка autosave
            if (method === 'POST' && urlObj.searchParams.get('action') === 'autosave') {
                return handleAutosave(options);
            }
            return handleProjects(urlObj, method, options);
        }
        
        // api/sketch-data.php
        if (path.endsWith('api/sketch-data.php')) {
            return handleSketchData(urlObj, method, options);
        }
        
        // api/history.php
        if (path.endsWith('api/history.php')) {
            return handleHistory(urlObj, method, options);
        }
        
        // api/user.php — заглушка
        if (path.endsWith('api/user.php')) {
            return jsonResponse({ success: true });
        }
        
        // Всё остальное — обычный fetch
        return originalFetch(url, options);
    };
    
    // ============================================================
    // ХЕЛПЕРЫ
    // ============================================================
    function jsonResponse(data, status) {
        return new Response(JSON.stringify(data), {
            status: status || 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    async function readBody(options) {
        if (!options.body) return {};
        try {
            return JSON.parse(options.body);
        } catch(e) {
            if (options.body instanceof FormData) {
                const obj = {};
                for (const [k, v] of options.body.entries()) obj[k] = v;
                return obj;
            }
            return {};
        }
    }
    
    // ============================================================
    // api/projects.php?action=autosave — быстрое сохранение объектов
    // ============================================================
    async function handleAutosave(options) {
        const body = await readBody(options);
        if (!body || !body.id) {
            return jsonResponse({ success: false, error: 'Bad request' }, 400);
        }
        try {
            await DB.updateProject(Number(body.id), { objects: body.objects });
            return jsonResponse({ success: true, autosave: true });
        } catch(e) {
            return jsonResponse({ success: false, error: e.message }, 500);
        }
    }
    
    // ============================================================
    // api/projects.php
    // ============================================================
    async function handleProjects(urlObj, method, options) {
        const body = await readBody(options);
        
        try {
            // GET ?id=N — один проект
            if (method === 'GET' && urlObj.searchParams.get('id')) {
                const id = Number(urlObj.searchParams.get('id'));
                const project = await DB.getProject(id);
                if (!project) return jsonResponse({ success: false, error: 'Project not found' }, 404);
                return jsonResponse({ success: true, project });
            }
            
            // GET — список проектов
            if (method === 'GET') {
                const projects = await DB.getProjects();
                return jsonResponse({ success: true, projects });
            }
            
            // POST — создать проект
            if (method === 'POST') {
                const name = body.name || 'Новый проект';
                const description = body.description || '';
                const projectType = body.project_type || '2d';
                const isSketch = body.is_sketch ? 1 : 0;
                const isOffsetPlane = body.is_offset_plane ? 1 : 0;
                const planeType = body.plane_type || null;
                const parentId = body.parent_project_id || null;
                
                // Сохраняем все дополнительные поля
                const project = await DB.createProject(name, description, projectType);
                
                // Дописываем дополнительными полями
                const extra = {};
                if (isSketch) extra.is_sketch = 1;
                if (isOffsetPlane) {
                    extra.is_offset_plane = 1;
                    extra.offset_origin_x = body.offset_origin_x;
                    extra.offset_origin_y = body.offset_origin_y;
                    extra.offset_origin_z = body.offset_origin_z;
                    extra.offset_normal_x = body.offset_normal_x;
                    extra.offset_normal_y = body.offset_normal_y;
                    extra.offset_normal_z = body.offset_normal_z;
                    extra.offset_distance = body.offset_distance;
                    extra.offset_name = body.offset_name;
                    extra.parent_plane = body.parent_plane;
                }
                if (planeType) extra.plane_type = planeType;
                if (parentId) extra.parent_project_id = parentId;
                if (body.objects) extra.objects = body.objects;
                
                if (Object.keys(extra).length > 0) {
                    await DB.updateProject(project.id, extra);
                }
                
                return jsonResponse({ success: true, project_id: project.id });
            }
            
            // PUT — обновить проект
            if (method === 'PUT') {
                const id = Number(body.id);
                if (!id) return jsonResponse({ success: false, error: 'Missing id' }, 400);
                
                const changes = {};
                const allowed = [
                    'name', 'objects', 'description', 'project_type',
                    'is_offset_plane', 'offset_origin_x', 'offset_origin_y', 'offset_origin_z',
                    'offset_normal_x', 'offset_normal_y', 'offset_normal_z',
                    'offset_distance', 'offset_name', 'parent_plane'
                ];
                for (const key of allowed) {
                    if (body[key] !== undefined) changes[key] = body[key];
                }
                
                const updated = await DB.updateProject(id, changes);
                return jsonResponse({ success: true, project: updated });
            }
            
            // DELETE — удалить проект
            if (method === 'DELETE') {
                const id = Number(body.id);
                if (!id) return jsonResponse({ success: false, error: 'No id' }, 400);
                await DB.deleteProject(id);
                return jsonResponse({ success: true, message: 'Project deleted' });
            }
            
            return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
        } catch(e) {
            console.error('❌ php-shim projects error:', e);
            return jsonResponse({ success: false, error: e.message }, 500);
        }
    }
    
    // ============================================================
    // api/sketch-data.php
    // ============================================================
    async function handleSketchData(urlObj, method, options) {
        const body = await readBody(options);
        
        try {
            // POST — сохранить драфт
            if (method === 'POST') {
                // ✅ Формат ответа должен совпадать с PHP:
                // { success: true, draft_key: "..." }
                const key = await DB.saveSketchDraft({
                    context: body.context || 'plane',
                    plane: body.plane || 'xy',
                    project_id: body.project_id || null,
                    face_data: body.face_data || null,
                    face_outline: body.face_outline || null,
                    initial_objects: body.initial_objects || null
                });
                return jsonResponse({ success: true, draft_key: key });
            }
            
            // GET ?key=... — получить драфт
            if (method === 'GET' && urlObj.searchParams.get('key')) {
                const key = urlObj.searchParams.get('key');
                const draft = await DB.getSketchDraft(key);
                if (!draft) return jsonResponse({ success: false, error: 'not_found' });
                return jsonResponse({
                    success: true,
                    context: draft.context,
                    plane: draft.plane,
                    project_id: draft.project_id,
                    face_data: draft.face_data,
                    face_outline: draft.face_outline,
                    initial_objects: draft.initial_objects
                });
            }
            
            // DELETE ?key=... — удалить драфт
            if (method === 'DELETE' && urlObj.searchParams.get('key')) {
                const key = urlObj.searchParams.get('key');
                await DB.deleteSketchDraft(key);
                return jsonResponse({ success: true });
            }
            
            return jsonResponse({ success: false, error: 'method_not_allowed' }, 405);
        } catch(e) {
            console.error('❌ php-shim sketch error:', e);
            return jsonResponse({ success: false, error: e.message }, 500);
        }
    }
    
    // ============================================================
    // api/history.php
    // ============================================================
    async function handleHistory(urlObj, method, options) {
        const body = await readBody(options);
        
        try {
            // POST — сохранить снимок
            if (method === 'POST') {
                const projectId = Number(body.project_id || 0);
                const snapshot = body.snapshot;
                const actionType = body.action_type || 'unknown';
                if (!projectId) return jsonResponse({ success: false, error: 'not_found' });
                if (snapshot === null) return jsonResponse({ success: false, error: 'no_snapshot' });
                await DB.pushHistory(projectId, snapshot, actionType);
                return jsonResponse({ success: true });
            }
            
            // GET — получить историю
            if (method === 'GET') {
                const projectId = Number(urlObj.searchParams.get('project_id') || 0);
                const limit = Math.min(50, Math.max(1, Number(urlObj.searchParams.get('limit') || 20)));
                const history = await DB.getHistory(projectId, limit);
                // Формат: массив { objects_snapshot: ... }
                const wrapped = history.map(snapshot => ({ objects_snapshot: snapshot }));
                return jsonResponse({ success: true, history: wrapped });
            }
            
            // DELETE — удалить самый свежий снимок
            if (method === 'DELETE') {
                const projectId = Number(urlObj.searchParams.get('project_id') || 0);
                await DB.popHistory(projectId);
                return jsonResponse({ success: true });
            }
            
            return jsonResponse({ success: false }, 405);
        } catch(e) {
            console.error('❌ php-shim history error:', e);
            return jsonResponse({ success: false, error: e.message }, 500);
        }
    }
    
    console.log('✅ php-shim.js активирован — fetch("api/...") работают через IndexedDB');
})();
