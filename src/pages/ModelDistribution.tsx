// Copyright (C) 2026 YIQISOFT
//
// SPDX-License-Identifier: Apache-2.0

// Model distribution console. Three workflows over one page:
//   1. Browse the NereidForge Model Registry and publish a ready precision
//      package to selected edge nodes through the ESS/MMS data plane.
//   2. Validate and publish an operator-supplied standard package from a local
//      upload or an allowlisted URL through the same ESS transport owner.
//   3. Inspect published MMS objects, their per-node delivery status, and delete.
// One MMS object carries one blob: a standard tar.gz with nereid-model.json,
// built by Forge or the operator. The console never assembles archives itself.
// The page only talks to the BFF; Forge tokens and Exchange credentials stay
// server-side. Publishing is platform-only (the BFF rejects partners).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layout, Menu, Card, Table, Button, Space, Typography, Input, Select, Tag, Modal,
  message, Alert, Tooltip, Descriptions, Badge, Radio, AutoComplete, Upload, Progress,
} from 'antd';
import {
  ReloadOutlined, CloudUploadOutlined, DeleteOutlined, RocketOutlined,
  SettingOutlined, ExperimentOutlined, UploadOutlined, LinkOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  ForgeRegistryAPI, ForgeModel, ForgeVersion, ForgePackageRecord, ForgePackageMetaRecord,
  PackagePrecision, MmsObject, MmsDestination, MmsDestStatus,
} from '../api/forgeRegistry';
import { OrgAPI } from '../api/organizations';
import { getConfig } from '../api/config';
import { useT } from '../i18n/context';
import { useScreenSize } from '../hooks/useIsMobile';
import { usePolling } from '../hooks/usePolling';
import HelpButton from '../components/HelpButton';

const { Text, Title } = Typography;

// Delivery status -> antd Badge status, shared by both the object and node views.
function deliveryBadge(status: string) {
  const map: Record<string, 'success' | 'processing' | 'warning' | 'error' | 'default'> = {
    delivered: 'success',
    consumed: 'success',
    delivering: 'processing',
    pending: 'warning',
    deleted: 'default',
    error: 'error',
  };
  return map[status] || 'default';
}

// Reduce a model/version string to the ESS-safe object-id character set.
function safeObjectId(raw: string) {
  return raw.replace(/[^\w.\-~!@#$^*]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180);
}

// Preset ESS object types for model artifacts. Grouped in the source: first
// the training/interchange frameworks, then vendor-compiled edge/NPU formats.
// Values must stay within the ESS-safe character set (no spaces/slashes). The
// list only offers suggestions: the field stays free-text for custom types.
// Preset ESS object types for model artifacts, ordered by popularity. The
// `value` is what gets stored/sent (ESS-safe, no spaces); `label` spells out
// the format/vendor. The field stays free-text for a custom type.
const PRESET_OBJECT_TYPES: { value: string; label: string }[] = [
  // Generic / interchange formats
  { value: 'onnx', label: 'onnx (ONNX)' },
  { value: 'pytorch', label: 'pytorch (PyTorch .pt/.pth)' },
  { value: 'tflite', label: 'tflite (TensorFlow Lite / LiteRT)' },
  { value: 'tf', label: 'tf (TensorFlow)' },
  { value: 'keras', label: 'keras (Keras)' },
  { value: 'tensorrt', label: 'tensorrt (NVIDIA TensorRT .engine/.plan)' },
  { value: 'openvino', label: 'openvino (Intel OpenVINO IR)' },
  { value: 'mo', label: 'mo (Intel Model Optimizer IR)' },
  { value: 'gguf', label: 'gguf (GGUF / llama.cpp)' },
  { value: 'safetensors', label: 'safetensors (SafeTensors)' },
  { value: 'paddle', label: 'paddle (PaddlePaddle)' },
  { value: 'mindspore', label: 'mindspore (MindSpore)' },
  { value: 'caffe', label: 'caffe (Caffe)' },
  { value: 'coreml', label: 'coreml (Apple Core ML)' },
  { value: 'ncnn', label: 'ncnn (Tencent ncnn)' },
  { value: 'mnn', label: 'mnn (Alibaba MNN)' },
  { value: 'ggml', label: 'ggml (GGML)' },
  { value: 'rnn', label: 'rnn (RNN)' },
  // Vendor SDK / compiled edge formats
  { value: 'rknn', label: 'rknn (Rockchip RKNN)' },
  { value: 'om', label: 'om (Huawei Ascend CANN)' },
  { value: 'bmodel', label: 'bmodel (SOPHGO BM168x)' },
  { value: 'hbm', label: 'hbm (Horizon BPU)' },
  { value: 'axmodel', label: 'axmodel (Axera)' },
  { value: 'mlu', label: 'mlu (Cambricon MLU)' },
  { value: 'musa', label: 'musa (Moore Threads MUSA)' },
  { value: 'dlc', label: 'dlc (Qualcomm SNPE DLC)' },
  { value: 'qnn', label: 'qnn (Qualcomm QNN)' },
  { value: 'hef', label: 'hef (Hailo)' },
  { value: 'tidl', label: 'tidl (Texas Instruments TIDL)' },
  { value: 'xmodel', label: 'xmodel (AMD / Xilinx Vitis AI)' },
  { value: 'edgetpu', label: 'edgetpu (Google Coral Edge TPU)' },
  { value: 'nef', label: 'nef (Kneron)' },
  { value: 'kmodel', label: 'kmodel (Kendryte K210/K230)' },
];
const PRESET_TYPE_VALUES = PRESET_OBJECT_TYPES.map((o) => o.value);

function formatBytes(n?: number) {
  const v = Number(n || 0);
  if (!v) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Precisions the Forge optimization pipeline packages, in display order.
const PACKAGE_PRECISIONS: PackagePrecision[] = ['fp32', 'fp16', 'int8'];

// Read a version's package records (version.metadata.packages[]). Current
// records are keyed by precision; legacy target-keyed records are ignored —
// the precision API does not serve them.
function packageMetaRecords(v?: ForgeVersion | null): ForgePackageMetaRecord[] {
  const pk = v?.metadata?.packages;
  return Array.isArray(pk) ? pk.filter((r: any) => r && typeof r.precision === 'string') : [];
}

// antd Tag color per Forge package build status.
function packageStatusColor(status?: string) {
  if (status === 'ready') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'running' || status === 'pending' || status === 'packaging') return 'processing';
  return 'default';
}

interface PublishTarget {
  model: ForgeModel;
  version: ForgeVersion;
}

export default function ModelDistribution() {
  const { t, fmtTime } = useT();
  const navigate = useNavigate();
  const config = getConfig();
  const isMobile = useScreenSize();

  const [tab, setTab] = useState('forge');
  const [integStatus, setIntegStatus] = useState<Awaited<ReturnType<typeof ForgeRegistryAPI.status>> | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [org, setOrg] = useState('');

  // Forge models tab
  const [models, setModels] = useState<ForgeModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [modelsTotal, setModelsTotal] = useState(0);
  const [page, setPage] = useState(1);

  // Published objects tab
  const [objects, setObjects] = useState<MmsObject[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  // Advances after every successful object-list fetch so expanded delivery
  // rows refetch too; their org/type/id props alone do not change on refresh.
  const [deliveryRefreshKey, setDeliveryRefreshKey] = useState(0);

  // Publish modal
  const [publishOpen, setPublishOpen] = useState(false);
  const [target, setTarget] = useState<PublishTarget | null>(null);
  // Ready precision packages of the chosen version (Forge builds these
  // automatically at optimization-job end; /packages lists ready ones only).
  const [readyPackages, setReadyPackages] = useState<ForgePackageRecord[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [precision, setPrecision] = useState<PackagePrecision>('fp16');
  const [destinations, setDestinations] = useState<MmsDestination[]>([]);
  // Operator-defined object types accumulate locally so a typed-in format is
  // offered again on later publishes (presets stay the built-in baseline).
  const [customObjectTypes, setCustomObjectTypes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('mms-custom-object-types') || '[]'); } catch { return []; }
  });
  const objectTypeOptions = useMemo(() => {
    const presets = PRESET_OBJECT_TYPES;
    const extras = customObjectTypes
      .filter((v) => !PRESET_TYPE_VALUES.includes(v))
      .map((v) => ({ value: v, label: v }));
    return [...presets, ...extras];
  }, [customObjectTypes]);
  const [selectedDests, setSelectedDests] = useState<string[]>([]);
  // No assumed object type: the operator picks/types it before publishing.
  const [objectType, setObjectType] = useState('');
  const [objectID, setObjectID] = useState('');
  const [description, setDescription] = useState('');
  const [publishing, setPublishing] = useState(false);

  // Custom packages share the publication envelope but not the Forge package
  // picker. Local uploads use XHR for progress and AbortController for cancel.
  const [customOpen, setCustomOpen] = useState(false);
  const [customSource, setCustomSource] = useState<'upload' | 'url'>('upload');
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [customPublishing, setCustomPublishing] = useState(false);
  const [customProgress, setCustomProgress] = useState(0);
  const [customUploadSent, setCustomUploadSent] = useState(false);
  const customAbort = useRef<AbortController | null>(null);

  // ---- initial load: integration status + org list ----
  useEffect(() => {
    (async () => {
      try {
        const st = await ForgeRegistryAPI.status();
        setIntegStatus(st);
      } catch { /* banner stays absent on hard failure */ }
      try {
        const res = await OrgAPI.list();
        // Only business orgs are distribution targets: exclude the hub system
        // orgs "root" and "IBM" (the latter is the global system organization).
        const ids = Object.keys(res?.orgs || {}).filter((o) => o !== 'root' && o !== 'IBM');
        setOrgs(ids);
        const initial = config.orgId && config.orgId !== 'root' ? config.orgId : ids[0] || '';
        setOrg(initial);
      } catch { /* org dropdown stays empty */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = useCallback(async (p = page, q = search) => {
    // Skip the upstream call when the registry is unconfigured; the banner
    // already explains what to do, so avoid an error toast on first render.
    if (integStatus && !(integStatus.forge.configured && integStatus.forge.authenticated)) {
      setModels([]);
      setModelsTotal(0);
      return;
    }
    setModelsLoading(true);
    try {
      const data = await ForgeRegistryAPI.listModels(p, 20, q);
      setModels(data.items || []);
      setModelsTotal(data.total || 0);
    } catch (e: any) {
      message.error(e?.message || 'Failed to load models');
    } finally {
      setModelsLoading(false);
    }
  }, [page, search, integStatus]);

  const loadObjects = useCallback(async (background = false) => {
    if (!org) return;
    if (!background) setObjectsLoading(true);
    try {
      setObjects(await ForgeRegistryAPI.listObjects(org));
      setDeliveryRefreshKey((key) => key + 1);
    } catch (e: any) {
      if (!background) message.error(e?.message || 'Failed to load objects');
    } finally {
      if (!background) setObjectsLoading(false);
    }
  }, [org]);

  useEffect(() => { if (tab === 'forge') loadModels(); /* eslint-disable-next-line */ }, [tab, page, integStatus]);
  useEffect(() => { if (tab === 'objects') loadObjects(); }, [tab, org, loadObjects]);
  usePolling(() => {
    if (tab === 'objects') void loadObjects(true);
  }, 30000);

  // Lazy-load a model's versions when its row is expanded.
  const loadVersions = async (m: ForgeModel): Promise<ForgeVersion[]> => {
    try {
      const data = await ForgeRegistryAPI.listVersions(m.name);
      return data.items || [];
    } catch {
      return [];
    }
  };

  // Fetch the version's ready precision packages; returns them so the caller
  // can preselect one. Forge has no build-trigger API, so this is read-only.
  const loadPackageList = useCallback(async (m: ForgeModel, v: ForgeVersion): Promise<ForgePackageRecord[]> => {
    setPackagesLoading(true);
    try {
      const res = await ForgeRegistryAPI.listPackages(m.name, v.version);
      setReadyPackages(res.packages || []);
      return res.packages || [];
    } catch {
      setReadyPackages([]);
      return [];
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  const loadDestinationList = useCallback(() => {
    if (!org) {
      setDestinations([]);
      return;
    }
    ForgeRegistryAPI.listDestinations(org)
      .then(setDestinations)
      .catch((e: any) => message.error(e?.message || 'Failed to load edge nodes'));
  }, [org]);

  const openPublish = async (model: ForgeModel, version: ForgeVersion) => {
    setTarget({ model, version });
    setObjectType('');
    setSelectedDests([]);
    setDestinations([]);
    setReadyPackages([]);
    setPrecision('fp16');
    setObjectID(`${safeObjectId(model.name)}-fp16`);
    setDescription(version.description || model.description || `${model.name} ${version.version} (fp16)`);
    setPublishOpen(true);
    loadDestinationList();
    const pkgs = await loadPackageList(model, version);
    const preselect = pkgs.map((r) => String(r.precision).toLowerCase())
      .find((p): p is PackagePrecision => (PACKAGE_PRECISIONS as string[]).includes(p));
    if (preselect) {
      setPrecision(preselect);
      setObjectID(`${safeObjectId(model.name)}-${preselect}`);
      setDescription(`${model.name} ${version.version} (${preselect})`);
    }
  };

  const changePrecision = (p: PackagePrecision) => {
    setPrecision(p);
    // Keep the suggested id in sync unless the operator edited it.
    const prevDefault = `${safeObjectId(target!.model.name)}-${precision}`;
    if (!objectID.trim() || objectID.trim() === prevDefault) {
      setObjectID(`${safeObjectId(target!.model.name)}-${p}`);
    }
  };

  const rememberObjectType = (value: string) => {
    if (PRESET_TYPE_VALUES.includes(value) || customObjectTypes.includes(value)) return;
    const next = [...customObjectTypes, value];
    setCustomObjectTypes(next);
    localStorage.setItem('mms-custom-object-types', JSON.stringify(next));
  };

  const openCustomPublish = () => {
    setCustomSource('upload');
    setCustomFile(null);
    setCustomUrl('');
    setCustomProgress(0);
    setCustomUploadSent(false);
    setObjectType('');
    setObjectID('');
    setDescription('');
    setSelectedDests([]);
    setDestinations([]);
    setCustomOpen(true);
    loadDestinationList();
  };

  const doCustomPublish = async () => {
    if (!org) return;
    if (selectedDests.length === 0) { message.warning(t('select-at-least-one-node')); return; }
    if (!objectType.trim() || !objectID.trim()) { message.warning(t('object-id-required')); return; }
    if (customSource === 'upload' && !customFile) { message.warning(t('custom-package-required')); return; }
    if (customSource === 'url' && !customUrl.trim()) { message.warning(t('custom-url-required')); return; }
    const finalType = objectType.trim();
    const fields = {
      objectType: finalType,
      objectID: objectID.trim(),
      destinations: selectedDests,
      description: description.trim(),
    };
    const controller = new AbortController();
    customAbort.current = controller;
    setCustomPublishing(true);
    setCustomProgress(0);
    setCustomUploadSent(false);
    try {
      if (customSource === 'upload') {
        await ForgeRegistryAPI.uploadCustomPackage(org, customFile!, fields, {
          signal: controller.signal,
          onProgress: setCustomProgress,
          onUploadSent: () => setCustomUploadSent(true),
        });
      } else {
        await ForgeRegistryAPI.publishCustomUrl(org, customUrl.trim(), fields);
      }
      rememberObjectType(finalType);
      message.success(t('publish-success'));
      setCustomOpen(false);
      setTab('objects');
      loadObjects();
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setCustomOpen(false);
        message.info(t('custom-upload-cancelled'));
      } else {
        message.error(e?.message || 'Publish failed');
      }
    } finally {
      customAbort.current = null;
      setCustomPublishing(false);
    }
  };

  const cancelCustomPublish = () => {
    if (customPublishing) {
      if (customSource === 'upload' && !customUploadSent) customAbort.current?.abort();
      return;
    }
    setCustomOpen(false);
  };

  const doPublish = async () => {
    if (!target || !org) return;
    if (selectedDests.length === 0) { message.warning(t('select-at-least-one-node')); return; }
    if (!objectType.trim() || !objectID.trim()) { message.warning(t('object-id-required')); return; }
    const ready = readyPackages.some((r) => String(r.precision).toLowerCase() === precision);
    if (!ready) { message.warning(t('package-not-ready')); return; }
    const finalType = objectType.trim();
    rememberObjectType(finalType);
    setPublishing(true);
    try {
      await ForgeRegistryAPI.publish(org, {
        modelName: target.model.name,
        version: target.version.version,
        precision,
        objectType: finalType,
        objectID: objectID.trim(),
        destinations: selectedDests,
        description: description.trim(),
      });
      message.success(t('publish-success'));
      setPublishOpen(false);
      setTab('objects');
      loadObjects();
    } catch (e: any) {
      message.error(e?.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };

  const confirmDelete = (obj: MmsObject) => {
    Modal.confirm({
      title: t('are-you-sure'),
      content: `${t('delete-object-confirm')}: ${obj.objectType}/${obj.objectID}`,
      okText: t('delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await ForgeRegistryAPI.deleteObject(org, obj.objectType, obj.objectID);
        message.success(t('deleted'));
        loadObjects();
      },
    });
  };

  const destOptions = useMemo(
    () => destinations.map((d) => ({
      value: `${d.destinationType}:${d.destinationID}`,
      label: `${d.destinationID} (${d.destinationType})`,
    })),
    [destinations],
  );

  // ---- table columns ----
  const modelColumns = [
    { title: t('model-name'), dataIndex: 'name', key: 'name', render: (v: string) => <Text code>{v}</Text> },
    { title: t('framework'), dataIndex: 'framework', key: 'framework', width: 110, render: (v: string) => v || '-' },
    { title: t('task-type'), dataIndex: 'task_type', key: 'task_type', width: 130, render: (v: string) => v || '-' },
    {
      title: t('description'), dataIndex: 'description', key: 'description', ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: t('updated-at'), dataIndex: 'updated_at', key: 'updated_at', width: 170,
      render: (v: string) => fmtTime(v),
    },
  ];

  const objectColumns = [
    { title: t('object-id'), dataIndex: 'objectID', key: 'objectID', render: (v: string) => <Text code>{v}</Text> },
    { title: t('object-type'), dataIndex: 'objectType', key: 'objectType', width: 120 },
    { title: t('model-version'), dataIndex: 'version', key: 'version', width: 110, render: (v: string) => v || '-' },
    {
      title: t('size'), dataIndex: 'objectSize', key: 'objectSize', width: 100,
      render: (v: number) => formatBytes(v),
    },
    {
      title: t('description'), dataIndex: 'description', key: 'description', width: 220, ellipsis: true,
      render: (v: string) => v ? <Tooltip title={v}><Text>{v}</Text></Tooltip> : '-',
    },
    {
      title: t('target-nodes'), key: 'dests', width: 200,
      render: (_: any, r: MmsObject) => {
        const dests = r.destinationsList || (r.destinationType ? [`${r.destinationType}:${r.destinationID || ''}`] : []);
        return dests.length
          ? dests.map((d) => <Tag key={d} style={{ marginBottom: 4 }}>{d}</Tag>)
          : <Text type="secondary">{t('all-nodes')}</Text>;
      },
    },
    {
      title: t('published-at'), dataIndex: 'publishedAt', key: 'publishedAt', width: 170,
      render: (v: string) => fmtTime(v),
    },
    {
      title: t('published-by'), dataIndex: 'publishedBy', key: 'publishedBy', width: 130,
      render: (v: string) => v || '-',
    },
    {
      title: t('actions'), key: 'actions', width: 80,
      render: (_: any, r: MmsObject) => (
        <Tooltip title={t('delete')}>
          <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => confirmDelete(r)} />
        </Tooltip>
      ),
    },
  ];

  const forgeReady = integStatus?.forge.configured && integStatus?.forge.authenticated;
  const essReady = integStatus?.ess.reachable;

  // Package build state for the version shown in the publish dialog.
  const pkgOf = (p: string) =>
    readyPackages.find((r) => String(r.precision).toLowerCase() === p.toLowerCase());
  const selectedPkg = pkgOf(precision);
  const selectedPkgReady = Boolean(selectedPkg);

  // Forge and custom packages share one operator-confirmed ESS envelope. The
  // package source never fills these fields from archive or URL contents.
  const renderPublicationEnvelope = () => (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div>
        <Text strong>{t('target-nodes')}</Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 6 }}
          placeholder={t('select-target-nodes')}
          value={selectedDests}
          onChange={setSelectedDests}
          options={destOptions}
          optionFilterProp="label"
          disabled={customPublishing}
        />
        {destinations.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('no-destinations-hint')}</Text>
        )}
      </div>
      <div>
        <Text strong>{t('object-type')}</Text>
        <AutoComplete
          style={{ width: '100%', marginTop: 6 }}
          value={objectType}
          onChange={setObjectType}
          options={objectTypeOptions}
          placeholder={t('object-type-placeholder')}
          disabled={customPublishing}
          filterOption={(input, option) => {
            const hay = `${option?.value ?? ''} ${option?.label ?? ''}`.toLowerCase();
            return hay.includes(input.toLowerCase());
          }}
        />
      </div>
      <div>
        <Text strong>{t('object-id')}</Text>
        <Input style={{ marginTop: 6 }} value={objectID} onChange={(e) => setObjectID(e.target.value)} disabled={customPublishing} />
        <Text type="secondary" style={{ fontSize: 12 }}>{t('object-id-hint')}</Text>
      </div>
      <div>
        <Text strong>{t('description')}</Text>
        <Input.TextArea style={{ marginTop: 6 }} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={customPublishing} />
      </div>
    </Space>
  );

  return (
    <Layout style={{ background: 'transparent' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap>
          <Title level={4} style={{ margin: 0 }}>
            <RocketOutlined /> {t('model-distribution')}
          </Title>
          <HelpButton module="model-distribution" />
        </Space>
        <Space wrap>
          <Select
            value={org || undefined}
            onChange={setOrg}
            style={{ minWidth: 160 }}
            placeholder={t('organization')}
            options={orgs.map((o) => ({ value: o, label: o }))}
            showSearch
          />
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={openCustomPublish}
            disabled={!org || !essReady}
            size="small"
          >
            {t('distribute-custom-package')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => (tab === 'forge' ? loadModels() : loadObjects())} size="small">
            {t('refresh')}
          </Button>
        </Space>
      </div>

      {!forgeReady && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={integStatus?.forge.configured ? t('forge-auth-failed') : t('forge-not-configured')}
          description={integStatus?.forge.error || undefined}
          action={<Button size="small" icon={<SettingOutlined />} onClick={() => navigate('/settings')}>{t('settings')}</Button>}
        />
      )}
      {!essReady && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('ess-unreachable')}
          description={`${integStatus?.ess.baseUrl || ''} ${integStatus?.ess.error || ''}`.trim() || undefined}
          action={<Button size="small" icon={<SettingOutlined />} onClick={() => navigate('/settings')}>{t('settings')}</Button>}
        />
      )}

      <Card size="small">
        <Menu
          mode={isMobile ? 'horizontal' : 'horizontal'}
          selectedKeys={[tab]}
          onClick={({ key }) => setTab(key)}
          items={[
            { key: 'forge', icon: <ExperimentOutlined />, label: t('forge-models') },
            { key: 'objects', icon: <CloudUploadOutlined />, label: t('published-objects') },
          ]}
          style={{ marginBottom: 16, borderBottom: 'none' }}
        />

        {tab === 'forge' && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Input.Search
                allowClear
                placeholder={t('search-by-name')}
                style={{ width: 260 }}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onSearch={() => { setPage(1); loadModels(1, search); }}
              />
            </Space>
            <Table
              rowKey="name"
              size="small"
              loading={modelsLoading}
              dataSource={models}
              columns={modelColumns}
              pagination={{
                current: page, pageSize: 20, total: modelsTotal, showSizeChanger: false,
                onChange: (p) => setPage(p),
              }}
              expandable={{
                expandRowByClick: false,
                expandedRowRender: (m: ForgeModel) => <VersionRows model={m} onPublish={openPublish} loadVersions={loadVersions} t={t} fmtTime={fmtTime} />,
                rowExpandable: () => true,
              }}
            />
          </>
        )}

        {tab === 'objects' && (
          <Table
            rowKey={(r) => `${r.objectType}/${r.objectID}`}
            size="small"
            loading={objectsLoading}
            dataSource={objects}
            columns={objectColumns}
            pagination={{ pageSize: 20 }}
            scroll={{ x: 1400 }}
            expandable={{
              expandedRowRender: (o: MmsObject) => (
                <ObjectDestStatus
                  org={org}
                  object={o}
                  refreshKey={deliveryRefreshKey}
                  t={t}
                  fmtTime={fmtTime}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        open={publishOpen}
        title={`${t('distribute-model')}: ${target?.model.name} @ ${target?.version.version}`}
        onCancel={() => setPublishOpen(false)}
        onOk={doPublish}
        confirmLoading={publishing}
        okButtonProps={{ disabled: !selectedPkgReady }}
        okText={publishing ? t('publishing') : t('publish')}
        destroyOnClose
        width={560}
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('organization')}>{org}</Descriptions.Item>
          <Descriptions.Item label={t('size')}>
            {selectedPkg?.package_bytes ? formatBytes(selectedPkg.package_bytes) : '-'}
          </Descriptions.Item>
        </Descriptions>

        <div style={{ marginBottom: 12 }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <Text strong>{t('inference-package')}</Text>
            <Tooltip title={t('refresh')}>
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                loading={packagesLoading}
                onClick={() => target && loadPackageList(target.model, target.version)}
              />
            </Tooltip>
          </Space>
          <Radio.Group
            value={precision}
            onChange={(e) => changePrecision(e.target.value)}
            style={{ display: 'block', marginTop: 6 }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {PACKAGE_PRECISIONS.map((p) => {
                const rec = pkgOf(p);
                return (
                  <div
                    key={p}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '4px 8px',
                      border: '1px solid rgba(128,128,128,0.25)', borderRadius: 6,
                    }}
                  >
                    <Radio value={p} disabled={!rec}>
                      <Space size={6} wrap>
                        {t(`precision-${p}`)}
                        {rec ? (
                          <>
                            <Tag color="green">{t('pkg-status-ready')}</Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>{formatBytes(rec.package_bytes)}</Text>
                            {typeof rec.quality_gate_passed === 'boolean' && (
                              <Tag color={rec.quality_gate_passed ? 'green' : 'red'}>
                                {t('quality-gate')}: {rec.quality_gate_passed ? t('passed') : t('failed')}
                              </Tag>
                            )}
                          </>
                        ) : (
                          <Tag>{t('pkg-status-none')}</Tag>
                        )}
                      </Space>
                    </Radio>
                  </div>
                );
              })}
            </Space>
          </Radio.Group>
          {!selectedPkgReady && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('package-not-ready-hint')} />
          )}
          <Alert type="info" showIcon style={{ marginTop: 8 }} message={t('package-hint')} />
        </div>

        {renderPublicationEnvelope()}
      </Modal>

      <Modal
        open={customOpen}
        title={t('distribute-custom-package')}
        onCancel={cancelCustomPublish}
        onOk={doCustomPublish}
        confirmLoading={customPublishing}
        closable={!customPublishing}
        maskClosable={!customPublishing}
        keyboard={!customPublishing}
        okButtonProps={{
          disabled: customSource === 'upload' ? !customFile : !customUrl.trim(),
        }}
        cancelButtonProps={{ disabled: customPublishing && (customSource === 'url' || customUploadSent) }}
        okText={customPublishing
          ? (customSource === 'upload' && !customUploadSent ? t('uploading') : t('publishing'))
          : t('publish')}
        cancelText={customPublishing && customSource === 'upload' && !customUploadSent ? t('cancel-upload') : t('cancel')}
        destroyOnClose
        width={600}
      >
        <Radio.Group
          value={customSource}
          onChange={(e) => setCustomSource(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          disabled={customPublishing}
          style={{ marginBottom: 16 }}
        >
          <Radio.Button value="upload"><UploadOutlined /> {t('custom-source-upload')}</Radio.Button>
          <Radio.Button value="url"><LinkOutlined /> {t('custom-source-url')}</Radio.Button>
        </Radio.Group>

        {customSource === 'upload' ? (
          <div style={{ marginBottom: 16 }}>
            <Upload
              accept=".tar.gz,.tgz,application/gzip"
              maxCount={1}
              disabled={customPublishing}
              fileList={customFile ? [{ uid: 'package', name: customFile.name, size: customFile.size }] : []}
              beforeUpload={(file) => { setCustomFile(file); return false; }}
              onRemove={() => { setCustomFile(null); }}
            >
              <Button icon={<UploadOutlined />}>{t('select-model-package')}</Button>
            </Upload>
            <Alert type="info" showIcon style={{ marginTop: 10 }} message={t('custom-package-hint')} />
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <Input
              prefix={<LinkOutlined />}
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder={t('custom-url-placeholder')}
              disabled={customPublishing}
            />
            <Alert type="info" showIcon style={{ marginTop: 10 }} message={t('custom-url-hint')} />
          </div>
        )}

        {customPublishing && customSource === 'upload' && (
          <div style={{ marginBottom: 16 }}>
            <Progress percent={customProgress} />
            <Text type="secondary">
              {customUploadSent ? t('custom-validating-publishing') : t('custom-uploading-hint')}
            </Text>
          </div>
        )}
        {customPublishing && customSource === 'url' && (
          <Alert style={{ marginBottom: 16 }} type="info" showIcon message={t('custom-url-downloading')} />
        )}
        {renderPublicationEnvelope()}
      </Modal>
    </Layout>
  );
}

// Expanded row: a model's versions with a per-version Distribute button.
function VersionRows({
  model, onPublish, loadVersions, t, fmtTime,
}: {
  model: ForgeModel;
  onPublish: (m: ForgeModel, v: ForgeVersion) => void;
  loadVersions: (m: ForgeModel) => Promise<ForgeVersion[]>;
  t: (k: string) => string;
  fmtTime: (iso?: string) => string;
}) {
  const [versions, setVersions] = useState<ForgeVersion[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    loadVersions(model).then((vs) => { if (alive) { setVersions(vs); setLoading(false); } });
    return () => { alive = false; };
  }, [model, loadVersions]);

  const columns = [
    { title: t('model-version'), dataIndex: 'version', key: 'version', render: (v: string) => <Text code>{v}</Text> },
    { title: t('size'), dataIndex: 'size_bytes', key: 'size_bytes', width: 100, render: (v: number) => formatBytes(v) },
    {
      title: t('inference-package'), key: 'packages', width: 180,
      render: (_: any, v: ForgeVersion) => {
        // metadata carries all states (incl. non-ready); /packages lists
        // ready ones only. Legacy target-keyed records are not displayable.
        const recs = packageMetaRecords(v);
        if (recs.length === 0) return <Text type="secondary">{t('pkg-status-none')}</Text>;
        return (
          <Space size={4} wrap>
            {recs.map((r) => (
              <Tag key={String(r.precision)} color={packageStatusColor(r.status)}>
                {String(r.precision).toUpperCase()}: {t(`pkg-status-${r.status || 'none'}`)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    { title: t('status'), dataIndex: 'status', key: 'status', width: 110, render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
    { title: t('created-at'), dataIndex: 'created_at', key: 'created_at', width: 170, render: (v: string) => fmtTime(v) },
    {
      title: t('actions'), key: 'go', width: 130,
      render: (_: any, v: ForgeVersion) => (
        <Button type="primary" size="small" icon={<CloudUploadOutlined />} onClick={() => onPublish(model, v)}>
          {t('distribute')}
        </Button>
      ),
    },
  ];
  return <Table rowKey="version" size="small" loading={loading} dataSource={versions} columns={columns} pagination={false} />;
}

// Expanded row: ESS metadata, NH publication provenance, and live per-node
// delivery status. Unknown historical provenance stays blank rather than
// substituting the application version or list-refresh time.
function ObjectDestStatus({
  org, object, refreshKey, t, fmtTime,
}: {
  org: string; object: MmsObject; refreshKey: number;
  t: (k: string) => string; fmtTime: (iso?: string) => string;
}) {
  const { objectType, objectID } = object;
  const [rows, setRows] = useState<MmsDestStatus[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    ForgeRegistryAPI.objectDestinations(org, objectType, objectID)
      .then((d) => { if (alive) setRows(d || []); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [org, objectType, objectID, refreshKey]);

  const columns = [
    { title: t('edge-node'), dataIndex: 'destinationID', key: 'destinationID', render: (v: string) => <Text code>{v}</Text> },
    { title: t('destination-type'), dataIndex: 'destinationType', key: 'destinationType' },
    {
      title: t('delivery-status'), dataIndex: 'status', key: 'status',
      render: (v: string, r: MmsDestStatus) => (
        <Space direction="vertical" size={0}>
          <Badge status={deliveryBadge(v)} text={<Tag>{v}</Tag>} />
          {r.message && <Text type="secondary" style={{ fontSize: 12 }}>{r.message}</Text>}
        </Space>
      ),
    },
  ];
  const knownSource = ['forge', 'custom-upload', 'url'].includes(object.publicationSource || '');
  const source = object.publicationSource
    ? (knownSource ? t(`publication-source-${object.publicationSource}`) : object.publicationSource)
    : '-';
  return (
    <>
      <Descriptions size="small" bordered column={1} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('description')}>{object.description || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('object-state')}>
          <Tag color={object.inactive ? 'orange' : 'green'}>{object.inactive ? t('inactive') : t('active')}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('publication-source')}>{source}</Descriptions.Item>
        {object.operationID && (
          <Descriptions.Item label="operationID">
            <Text code copyable={{ text: object.operationID }}>{object.operationID}</Text>
          </Descriptions.Item>
        )}
        {object.packageSHA256 && (
          <Descriptions.Item label={t('package-sha256')}>
            <Text code copyable={{ text: object.packageSHA256 }} style={{ wordBreak: 'break-all' }}>{object.packageSHA256}</Text>
          </Descriptions.Item>
        )}
        {object.activationTime && (
          <Descriptions.Item label={t('activation-time')}>{fmtTime(object.activationTime)}</Descriptions.Item>
        )}
        {object.expiration && (
          <Descriptions.Item label={t('expiration-time')}>{fmtTime(object.expiration)}</Descriptions.Item>
        )}
      </Descriptions>
      <Table rowKey={(r) => `${r.destinationType}:${r.destinationID}`} size="small" loading={loading} dataSource={rows} columns={columns} pagination={false} />
    </>
  );
}
