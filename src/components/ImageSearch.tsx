// Copyright (C) 2026 YIQISOFT
// SPDX-License-Identifier: Apache-2.0


import { useState, useRef, useEffect, useCallback } from 'react';
import { AutoComplete, Input, Space, Typography } from 'antd';
import { get as apiGet } from '../api/client';
import { useT } from '../i18n/context';

interface RegistryResult {
  name: string;
  fullName: string;
  description: string;
  starCount: number;
  isOfficial: boolean;
}

interface ImageSearchProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}

function parseValue(v: string | undefined) {
  if (!v) return { imageName: '', tag: '' };
  const idx = v.lastIndexOf(':');
  if (idx === -1) return { imageName: v, tag: '' };
  return { imageName: v.slice(0, idx), tag: v.slice(idx + 1) };
}

export default function ImageSearch({ value, onChange, placeholder }: ImageSearchProps) {
  const { t } = useT();
  const { imageName, tag } = parseValue(value);
  const [options, setOptions] = useState<{ value: string; label: React.ReactNode }[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  // Distinguishes a failed tag lookup (registry unreachable, auth required,
  // repo missing) from a successful lookup that simply returned no tags.
  const [tagsFailed, setTagsFailed] = useState(false);
  const [selectedImage, setSelectedImage] = useState(imageName);
  const [tagSelectOpen, setTagSelectOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSelectedImage(imageName);
  }, [imageName]);

  useEffect(() => {
    if (!selectedImage) { setTags([]); setTagsFailed(false); setTagSelectOpen(false); return; }
    setLoadingTags(true);
    setTagsFailed(false);
    setTagSelectOpen(false);
    apiGet<{ tags: string[]; error?: boolean }>(`/registry/tags?image=${encodeURIComponent(selectedImage)}`)
      .then((data) => {
        const list = data.tags || [];
        setTags(list);
        setTagsFailed(Boolean(data.error));
        if (list.length > 0) setTagSelectOpen(true);
      })
      .catch(() => { setTags([]); setTagsFailed(true); })
      .finally(() => setLoadingTags(false));
  }, [selectedImage]);

  const handleSearch = (query: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query || query.length < 2) { setOptions([]); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const data = await apiGet<{ results: RegistryResult[] }>(`/registry/search?q=${encodeURIComponent(query)}`);
        setOptions(
          (data.results || []).map((r) => ({
            value: r.fullName,
            label: (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{r.fullName}</span>
                <span style={{ fontSize: 11, color: '#888' }}>{r.description ? r.description.slice(0, 40) : ''}</span>
              </div>
            ),
          })),
        );
      } catch { setOptions([]); }
    }, 300);
  };

  const handleSelect = (val: string) => {
    setSelectedImage(val);
    setTags([]);
  };

  const handleNameChange = (val: string) => {
    setSelectedImage(val);
    if (!val) {
      setTags([]);
      onChange?.('');
      return;
    }
    const combined = tag ? `${val}:${tag}` : val;
    onChange?.(combined);
  };

  const handleTagChange = (val: string) => {
    // AutoComplete fires undefined on clear; emit the bare image name instead
    // of producing an "image:undefined" coordinate.
    const next = val ?? '';
    onChange?.(next ? `${selectedImage}:${next}` : selectedImage);
  };

  const openTagDropdown = () => {
    if (tags.length > 0) setTagSelectOpen(true);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      <AutoComplete
        value={imageName}
        options={options}
        onSearch={handleSearch}
        onChange={handleNameChange}
        onSelect={handleSelect}
        style={{ width: '100%' }}
        allowClear
      >
        <Input placeholder={placeholder} />
      </AutoComplete>
      {selectedImage && (
        <>
          <AutoComplete
            value={tag}
            options={tags.map((item) => ({ value: item, label: item }))}
            open={tagSelectOpen}
            onFocus={openTagDropdown}
            onSearch={openTagDropdown}
            onDropdownVisibleChange={(visible) => { if (!visible) setTagSelectOpen(false); }}
            onChange={handleTagChange}
            style={{ width: '100%' }}
            allowClear
            placeholder={t('image-tag-placeholder')}
            notFoundContent={loadingTags ? t('image-tag-loading') : null}
          />
          {!loadingTags && (tagsFailed || tags.length === 0) && (
            <Typography.Text type={tagsFailed ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              {tagsFailed ? t('image-tag-fetch-failed') : t('image-tag-empty')}
            </Typography.Text>
          )}
        </>
      )}
    </Space>
  );
}
