// js/user-id.js — локальный пользователь (в офлайн-APK один пользователь = одно устройство)

(function() {
    'use strict';
    
    const ID_KEY = 'webcad_user_id';
    const NAME_KEY = 'webcad_user_name';
    
    function generateId() {
        return 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 12);
    }
    
    function generateName() {
        return 'Мастер ' + Math.floor(Math.random() * 10000);
    }
    
    function getUserId() {
        let uid = localStorage.getItem(ID_KEY);
        if (!uid) {
            uid = generateId();
            localStorage.setItem(ID_KEY, uid);
            console.log('👤 Создан локальный пользователь:', uid);
        }
        return uid;
    }
    
    function getUserName() {
        let name = localStorage.getItem(NAME_KEY);
        if (!name) {
            name = generateName();
            localStorage.setItem(NAME_KEY, name);
        }
        return name;
    }
    
    function setUserName(newName) {
        localStorage.setItem(NAME_KEY, newName);
        console.log('✏️ Имя изменено на:', newName);
    }
    
    window.WebCADUser = {
        getUserId,
        getUserName,
        setUserName
    };
    
    console.log('✅ js/user-id.js загружен, пользователь:', getUserName());
})();
