// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0


import { useState, useEffect } from 'react';
import { useOutlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Button, Tag, Typography, theme, Select, Drawer, Dropdown, message } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import {
  DashboardOutlined,
  TeamOutlined,
  LaptopOutlined,
  AppstoreOutlined,
  ApartmentOutlined,
  FileTextOutlined,
  SettingOutlined,
  RobotOutlined,
  BookOutlined,
  SafetyOutlined,
  LogoutOutlined,
  HddOutlined,
  QuestionCircleOutlined,
  BuildOutlined,
  KeyOutlined,
  IdcardOutlined,
  UserOutlined,
  LockOutlined,
  CloudServerOutlined,
  SearchOutlined,
  DownOutlined,
  HeartOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { clearSession, getConfig, setOrgId } from '../api/config';
import { useT } from '../i18n/context';
import ChangesNotification from './ChangesNotification';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

function useExchangeVersion() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then((d) => setVersion(d?.version || ''))
      .catch(() => {});
  }, []);
  return version;
}

function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const outlet = useOutlet();
  const { token: themeToken } = theme.useToken();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawer, setMobileDrawer] = useState(false);
  const [orgSwitching, setOrgSwitching] = useState(false);
  const [, forceRender] = useState(0);
  const isMobile = useIsMobile();
  const config = getConfig();
  const { t, lang, setLang } = useT();
  const exchangeVersion = useExchangeVersion();

  // Menu is grouped into collapsible sections so the sidebar stays short;
  // Dashboard stays pinned at the top. Group keys ("grp-*") are not routes.
  const platformMenu = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('dashboard') },
    {
      key: 'grp-edge', icon: <LaptopOutlined />, label: t('menu-edge'),
      children: [
        { key: '/nodes', icon: <LaptopOutlined />, label: t('edge-nodes') },
        { key: '/node-search', icon: <SearchOutlined />, label: t('node-search') },
        { key: '/service-instances', icon: <CloudServerOutlined />, label: t('service-instances') },
        { key: '/hagroups', icon: <SafetyOutlined />, label: t('ha-groups') },
        { key: '/agentfileversion', icon: <SettingOutlined />, label: t('agent-file-version') },
      ],
    },
    {
      key: 'grp-workloads', icon: <AppstoreOutlined />, label: t('menu-workloads'),
      children: [
        { key: '/catalog', icon: <BookOutlined />, label: t('catalog') },
        { key: '/services', icon: <AppstoreOutlined />, label: t('services') },
        { key: '/model-distribution', icon: <RocketOutlined />, label: t('model-distribution') },
        { key: '/patterns', icon: <ApartmentOutlined />, label: t('deployment-patterns') },
        { key: '/policies', icon: <FileTextOutlined />, label: t('deployment-policies') },
        { key: '/mgmtpolicies', icon: <SettingOutlined />, label: t('management-policies') },
        { key: '/secrets', icon: <LockOutlined />, label: t('secrets') },
        { key: '/agbots', icon: <RobotOutlined />, label: t('agreement-bots') },
      ],
    },
    {
      key: 'grp-admin', icon: <TeamOutlined />, label: t('menu-admin'),
      children: [
        { key: '/organizations', icon: <BuildOutlined />, label: t('organization-management') },
        { key: '/users', icon: <TeamOutlined />, label: t('user-management') },
        { key: '/bff-users', icon: <IdcardOutlined />, label: t('bff-users') },
        { key: '/apikeys', icon: <KeyOutlined />, label: t('api-keys') },
        { key: '/audit', icon: <FileTextOutlined />, label: t('audit-log') },
      ],
    },
  ];

  const partnerMenu = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('dashboard') },
    {
      key: 'grp-edge', icon: <LaptopOutlined />, label: t('menu-edge'),
      children: [
        { key: '/nodes', icon: <LaptopOutlined />, label: t('edge-nodes') },
        { key: '/node-search', icon: <SearchOutlined />, label: t('node-search') },
        { key: '/service-instances', icon: <CloudServerOutlined />, label: t('service-instances') },
        { key: '/hagroups', icon: <SafetyOutlined />, label: t('ha-groups') },
        { key: '/agentfileversion', icon: <SettingOutlined />, label: t('agent-file-version') },
      ],
    },
    {
      key: 'grp-workloads', icon: <AppstoreOutlined />, label: t('menu-workloads'),
      children: [
        { key: '/services', icon: <AppstoreOutlined />, label: t('services') },
        { key: '/patterns', icon: <ApartmentOutlined />, label: t('deployment-patterns') },
        { key: '/policies', icon: <FileTextOutlined />, label: t('deployment-policies') },
        { key: '/mgmtpolicies', icon: <SettingOutlined />, label: t('management-policies') },
        { key: '/secrets', icon: <LockOutlined />, label: t('secrets') },
        { key: '/agbots', icon: <RobotOutlined />, label: t('agreement-bots') },
      ],
    },
    {
      key: 'grp-admin', icon: <TeamOutlined />, label: t('menu-admin'),
      children: [
        { key: '/apikeys', icon: <KeyOutlined />, label: t('api-keys') },
        { key: '/users', icon: <TeamOutlined />, label: t('users') },
        { key: '/audit', icon: <FileTextOutlined />, label: t('audit-log') },
      ],
    },
  ];

  const menuItems = config.role === 'platform' ? platformMenu : partnerMenu;

  const handleLogout = async () => {
    let redirect: string | null = null;
    try {
      const res = await fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-Csrf-Token': config.csrfToken || '' },
      });
      if (res.ok) {
        const data = await res.json();
        redirect = data?.redirect || null;
      }
    } catch { /* ignore */ }
    clearSession();
    // For OIDC sessions the backend returns the IdP end-session URL so the
    // upstream SSO session is also terminated; otherwise fall back to /login.
    if (redirect) {
      window.location.href = redirect;
    } else {
      navigate('/login');
    }
  };

  // Partners granted multiple orgs via SSO groups may switch the effective org.
  const canSwitchOrg = config.role === 'partner' && (config.availableOrgs?.length ?? 0) > 1;

  const handleSwitchOrg = async (org: string) => {
    if (org === config.orgId) return;
    setOrgSwitching(true);
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': config.csrfToken || '' },
        body: JSON.stringify({ org }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.msg || 'switch failed');
      setOrgId(org);
      forceRender((n) => n + 1);
    } catch (err: any) {
      message.error(err?.message || String(err));
    } finally {
      setOrgSwitching(false);
    }
  };

  const selectedKey = '/' + location.pathname.split('/').filter(Boolean)[0];

  // Flatten one level of grouped menus to get the real route keys ("grp-*"
  // section keys are not routes).
  const flattenRouteKeys = (items: any[]): string[] =>
    items.flatMap((i) => (i.children ? i.children.map((c: any) => c.key) : [i.key])).filter(Boolean);

  // Route guard: redirect to dashboard if route is invalid for the role
  useEffect(() => {
    const alwaysAllowed = ['/settings', '/profile', '/help'];
    const validKeys = flattenRouteKeys(menuItems);
    if (selectedKey !== '/dashboard' && !validKeys.includes(selectedKey) && !alwaysAllowed.includes(selectedKey)) {
      navigate('/dashboard', { replace: true });
    }
  }, [selectedKey]);

  // Expand the section that contains the current route on first render.
  const groupOfRoute = menuItems.find((i: any) => i.children?.some((c: any) => c.key === selectedKey));
  const defaultOpenKeys = groupOfRoute ? [groupOfRoute.key] : [];

  const renderMenu = (onClick?: () => void) => (
    <Menu
      theme="light"
      mode="inline"
      selectedKeys={[selectedKey]}
      defaultOpenKeys={defaultOpenKeys}
      items={menuItems}
      onClick={({ key }) => {
        if (!key.startsWith('/')) return; // section header click
        navigate(key);
        onClick?.();
      }}
      style={{ borderInlineEnd: 'none', marginTop: 8 }}
    />
  );

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      {!isMobile && (
        <Sider
          trigger={null}
          collapsible
          collapsed={collapsed}
          collapsedWidth={80}
          theme="light"
          width={256}
          style={{ borderRight: `1px solid ${themeToken.colorBorderSecondary}`, display: 'flex', flexDirection: 'column', position: 'relative' }}
        >
          <div
            style={{
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              padding: '0 16px',
              borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
            }}
          >
            <Text strong style={{ color: themeToken.colorPrimary, fontSize: 18 }}>
              {collapsed ? 'NH' : 'NereidHorizon'}
            </Text>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {renderMenu()}
          </div>
          {exchangeVersion && (
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '12px 16px', textAlign: collapsed ? 'center' : 'left', borderTop: `1px solid ${themeToken.colorBorderSecondary}`, background: themeToken.colorBgContainer }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {collapsed ? exchangeVersion : `Exchange ${exchangeVersion}`}
              </Text>
            </div>
          )}
        </Sider>
      )}
      <Layout>
        <Header
          style={{
            background: themeToken.colorBgContainer,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
            height: 64,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!isMobile && (
              <Button
                type="text"
                icon={collapsed ? <MenuOutlined /> : <MenuOutlined />}
                onClick={() => setCollapsed(!collapsed)}
                aria-label="toggle sidebar"
              />
            )}
            {isMobile && (
              <Button type="text" icon={<MenuOutlined />} onClick={() => setMobileDrawer(true)} aria-label="menu" />
            )}
            <Text type="secondary">
              <HddOutlined /> {config.orgId}
            </Text>
            {canSwitchOrg && (
              <Select
                value={config.orgId}
                loading={orgSwitching}
                onChange={handleSwitchOrg}
                options={(config.availableOrgs || []).map((o) => ({ value: o, label: o }))}
                size="small"
                style={{ minWidth: 140 }}
                placeholder={t('switch-organization')}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Select
              value={lang}
              onChange={(val) => setLang(val)}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
              size="small"
              style={{ width: 92 }}
              variant="borderless"
            />
            <Tag color={config.role === 'platform' ? 'red' : 'blue'}>
              {config.role === 'platform' ? t('platform') : t('partner')}
            </Tag>
            <ChangesNotification />
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'user-info',
                    label: (
                      <div style={{ padding: '4px 0' }}>
                        <Text strong>{config.username}</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 12 }}>{config.orgId}</Text>
                      </div>
                    ),
                    disabled: true,
                  },
                  { type: 'divider' },
                  {
                    key: 'profile',
                    icon: <UserOutlined />,
                    label: t('profile'),
                    onClick: () => navigate('/profile'),
                  },
                  {
                    key: 'settings',
                    icon: <SettingOutlined />,
                    label: t('settings'),
                    onClick: () => navigate('/settings'),
                  },
                  {
                    key: 'help',
                    icon: <QuestionCircleOutlined />,
                    label: t('help'),
                    onClick: () => navigate('/help'),
                  },
                  { type: 'divider' },
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: t('logout'),
                    onClick: handleLogout,
                  },
                ],
              }}
              trigger={['click']}
            >
              <Button type="text" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <UserOutlined />
                <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {config.username}
                </span>
                <DownOutlined />
              </Button>
            </Dropdown>
          </div>
        </Header>
        <Content style={{ margin: isMobile ? 12 : 24, overflow: 'auto', paddingRight: isMobile ? 0 : undefined }}>
          {/* Remount route subtree when the effective org changes so pages refetch */}
          <div key={config.orgId}>{outlet}</div>
        </Content>
      </Layout>
      <Drawer
        placement="left"
        open={mobileDrawer}
        onClose={() => setMobileDrawer(false)}
        width={256}
        styles={{ body: { padding: 0, background: themeToken.colorBgContainer, display: 'flex', flexDirection: 'column' }, header: { display: 'none' }, wrapper: { background: themeToken.colorBgContainer } }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
          }}
        >
          <Text strong style={{ color: themeToken.colorPrimary, fontSize: 18 }}>
            NereidHorizon
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {renderMenu(() => setMobileDrawer(false))}
        </div>
        {exchangeVersion && (
          <div style={{ padding: '12px 16px', borderTop: `1px solid ${themeToken.colorBorderSecondary}`, marginTop: 'auto', textAlign: 'left', background: themeToken.colorBgContainer }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Exchange {exchangeVersion}
            </Text>
          </div>
        )}
      </Drawer>
    </Layout>
  );
}
