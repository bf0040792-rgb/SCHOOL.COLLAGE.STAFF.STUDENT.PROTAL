document.addEventListener("DOMContentLoaded", () => {
    // 1. Inject CSS if not already linked
    if (!document.querySelector('link[href*="modern-ui.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'modern-ui.css';
        document.head.appendChild(link);
    }

    // 2. Setup Theme Logic
    const savedTheme = localStorage.getItem('portalTheme') || 'dark';
    if (savedTheme === 'light') document.body.classList.add('light-theme');

    window.toggleTheme = () => {
        document.body.classList.toggle('light-theme');
        const isLight = document.body.classList.contains('light-theme');
        localStorage.setItem('portalTheme', isLight ? 'light' : 'dark');
        if (window.initDashboardChart) window.initDashboardChart();
    };

    // 3. Global Sidebar Toggle
    window.toggleSidebar = (type = 'admin') => {
        const isStaff = type === 'staff';
        const sidebarId = isStaff ? 'staff-main-sidebar' : 'main-sidebar';
        const backdropId = isStaff ? 'staff-sidebar-backdrop' : 'sidebar-backdrop';
        const sidebar = document.getElementById(sidebarId);
        const backdrop = document.getElementById(backdropId);
        if (!sidebar) return;

        const isMobile = window.innerWidth <= 1024;
        if (isMobile) {
            const isOpen = sidebar.classList.contains('sidebar-open');
            if (isOpen) {
                sidebar.classList.remove('sidebar-open');
                if (backdrop) backdrop.classList.remove('active');
            } else {
                sidebar.classList.add('sidebar-open');
                if (backdrop) backdrop.classList.add('active');
            }
        } else {
            // Desktop toggle: collapse or expand
            sidebar.classList.toggle('sidebar-collapsed');
        }
    };

    // 4. Filter Sidebar Navigation Items
    window.filterSidebarMenus = (query = '', type = 'admin') => {
        const prefix = type === 'staff' ? '#staff-main-sidebar' : '#main-sidebar';
        const q = query.toLowerCase().trim();
        document.querySelectorAll(`${prefix} .sidebar-nav-item`).forEach(item => {
            const text = item.innerText.toLowerCase();
            if (!q || text.includes(q)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
        document.querySelectorAll(`${prefix} .sidebar-group`).forEach(group => {
            const anyVisible = Array.from(group.querySelectorAll('.sidebar-nav-item')).some(i => i.style.display !== 'none');
            group.style.display = anyVisible ? 'block' : 'none';
        });
    };
});
