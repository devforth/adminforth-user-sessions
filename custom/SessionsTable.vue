<template>
  <div v-if="allowed">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <slot name="heading" />
      <Button
        variant="danger"
        :disabled="!revokableCount || revokingAll"
        :loader="revokingAll"
        @click="revokeAll"
      >
        {{ userPk ? $t('Revoke all sessions') : $t('Revoke all other sessions') }}
      </Button>
    </div>

    <Table
      class="mt-6"
      :columns="columns"
      :data="sessions"
      :isLoading="loading"
      :pageSize="10"
    >
      <template #cell:device="{ item }">
        <div class="flex items-center gap-2">
          <component :is="DEVICE_ICONS[item.device?.type ?? 'unknown']" class="w-5 h-5 shrink-0 text-gray-500 dark:text-gray-400" />
          <div>
            <p :class="item.device ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-400'">
              {{ deviceLabel(item.device) }}
            </p>
            <p v-if="item.isCurrent" class="mt-0.5 text-xs font-medium text-green-600 dark:text-green-400">
              {{ $t('This device') }}
            </p>
          </div>
        </div>
      </template>

      <template #cell:country="{ item }">
        <div class="flex items-center gap-2">
          <CountryFlag v-if="item.country" :countryCode="item.country" />
          <span :class="item.country ? 'text-gray-900 dark:text-white' : 'text-gray-400'">
            {{ item.country || $t('Unknown') }}
          </span>
        </div>
      </template>

      <template #cell:ip="{ item }">
        <span :class="item.ip ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-400'">
          {{ item.ip || $t('Unknown') }}
        </span>
      </template>

      <template #cell:created_at="{ item }">
        {{ formatDateTime(item.created_at) }}
      </template>

      <template #cell:last_used_at="{ item }">
        {{ formatDateTime(item.last_used_at) }}
      </template>

      <template #header:actions="{ column }">
        <span class="flex justify-center">{{ column.label }}</span>
      </template>

      <template #cell:actions="{ item }">
        <div class="flex justify-center">
          <Button
            v-if="!item.isCurrent"
            variant="danger"
            :loader="revokingId === item.sessionId"
            :disabled="revokingId === item.sessionId"
            @click="revoke(item)"
          >
            {{ $t('Revoke') }}
          </Button>
        </div>
      </template>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IconDesktopPcOutline,
  IconMobilePhoneOutline,
  IconQuestionCircleOutline,
  IconTabletOutline,
} from '@iconify-prerendered/vue-flowbite';
import { Button, CountryFlag, Table } from '@/afcl';
import adminforth from '@/adminforth';
import { callAdminForthApi, formatDateTime } from '@/utils';

type SessionDevice = {
  browser: string | null;
  os: string | null;
  type: 'desktop' | 'mobile' | 'tablet';
};

type UserSession = {
  sessionId: string;
  ip: string | null;
  country: string | null;
  device: SessionDevice | null;
  created_at: string;
  last_used_at: string;
  isCurrent: boolean;
};

const DEVICE_ICONS = {
  desktop: IconDesktopPcOutline,
  mobile: IconMobilePhoneOutline,
  tablet: IconTabletOutline,
  unknown: IconQuestionCircleOutline,
};

/** Primary key of the user whose sessions are shown. Sessions of the logged in user when not set. */
const props = defineProps<{ userPk?: string }>();

const { t } = useI18n();

const sessions = ref<UserSession[]>([]);
const loading = ref(true);
// sessions of another user are shown only after the backend confirmed it is allowed
const allowed = ref(!props.userPk);
const revokingId = ref<string | null>(null);
const revokingAll = ref(false);

const columns = computed(() => [
  { label: t('Device'), fieldName: 'device' },
  { label: t('Country'), fieldName: 'country', sortable: true },
  { label: t('IP address'), fieldName: 'ip' },
  { label: t('Signed in'), fieldName: 'created_at', sortable: true },
  { label: t('Last used'), fieldName: 'last_used_at', sortable: true },
  { label: t('Actions'), fieldName: 'actions' },
]);

/**
 * `Chrome 131 on macOS`, or whichever half of it the user agent told us.
 */
function deviceLabel(device: SessionDevice | null): string {
  if (!device?.browser) {
    return device?.os ?? t('Unknown device');
  }
  return device.os ? t('{browser} on {os}', { browser: device.browser, os: device.os }) : device.browser;
}

const revokableCount = computed(() => sessions.value.filter((session) => !session.isCurrent).length);

onMounted(loadSessions);

async function loadSessions() {
  loading.value = true;
  try {
    const response = await callAdminForthApi({
      method: 'POST',
      path: '/plugin/user-sessions/list',
      body: { userPk: props.userPk },
    });
    if (response) {
      allowed.value = response.allowed;
      sessions.value = response.sessions;
    }
  } finally {
    loading.value = false;
  }
}

async function revoke(session: UserSession) {
  const confirmed = await adminforth.confirm({
    message: t('Revoke session of {device}? That browser will be signed out.', { device: deviceLabel(session.device) }),
    yes: t('Revoke'),
    no: t('Cancel'),
    dangerous: true,
  });
  if (!confirmed) return;

  revokingId.value = session.sessionId;
  try {
    await callAdminForthApi({
      method: 'POST',
      path: '/plugin/user-sessions/revoke',
      body: { sessionId: session.sessionId, userPk: props.userPk },
    });
    await loadSessions();
  } finally {
    revokingId.value = null;
  }
}

async function revokeAll() {
  const confirmed = await adminforth.confirm({
    message: props.userPk
      ? t('Revoke all sessions of this user? Every browser they are signed in from will be signed out.')
      : t('Revoke all other sessions? Every browser except this one will be signed out.'),
    yes: t('Revoke all'),
    no: t('Cancel'),
    dangerous: true,
  });
  if (!confirmed) return;

  revokingAll.value = true;
  try {
    const response = await callAdminForthApi({
      method: 'POST',
      path: '/plugin/user-sessions/revoke-others',
      body: { userPk: props.userPk },
    });
    if (response?.ok) {
      adminforth.alert({
        message: t('Revoked {count} session(s)', { count: response.revoked }),
        variant: 'success',
      });
    }
    await loadSessions();
  } finally {
    revokingAll.value = false;
  }
}
</script>
