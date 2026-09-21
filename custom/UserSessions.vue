<template>
  <div class="af-user-sessions flex flex-col justify-center mr-6 md:mr-12">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-3xl font-semibold leading-none text-gray-800 dark:text-gray-50">
          {{ $t('Active sessions') }}
        </h2>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('Every browser you signed in from has its own session. Revoke the ones you do not recognize.') }}
        </p>
      </div>
      <Button
        variant="danger"
        :disabled="!otherSessionsCount || revokingAll"
        :loader="revokingAll"
        @click="revokeOthers"
      >
        {{ $t('Revoke all other sessions') }}
      </Button>
    </div>

    <Table
      class="mt-6"
      :columns="columns"
      :data="sessions"
      :isLoading="loading"
      :pageSize="10"
    >
      <template #cell:location="{ item }">
        <div class="flex items-center gap-2">
          <CountryFlag v-if="item.country" :countryCode="item.country" />
          <div>
            <p class="font-medium text-gray-900 dark:text-white">{{ item.ip || $t('Unknown IP') }}</p>
            <p v-if="item.isCurrent" class="mt-0.5 text-xs font-medium text-green-600 dark:text-green-400">
              {{ $t('This device') }}
            </p>
          </div>
        </div>
      </template>

      <template #cell:created_at="{ item }">
        {{ formatDateTime(item.created_at) }}
      </template>

      <template #cell:last_used_at="{ item }">
        {{ formatDateTime(item.last_used_at) }}
      </template>

      <template #cell:actions="{ item }">
        <div class="flex justify-end">
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
import { Button, CountryFlag, Table } from '@/afcl';
import adminforth from '@/adminforth';
import { callAdminForthApi, formatDateTime } from '@/utils';

type UserSession = {
  sessionId: string;
  ip: string | null;
  country: string | null;
  created_at: string;
  last_used_at: string;
  isCurrent: boolean;
};

const { t } = useI18n();

const sessions = ref<UserSession[]>([]);
const loading = ref(true);
const revokingId = ref<string | null>(null);
const revokingAll = ref(false);

const columns = computed(() => [
  { label: t('Location'), fieldName: 'location' },
  { label: t('Signed in'), fieldName: 'created_at', sortable: true },
  { label: t('Last used'), fieldName: 'last_used_at', sortable: true },
  { label: t('Actions'), fieldName: 'actions' },
]);

const otherSessionsCount = computed(() => sessions.value.filter((session) => !session.isCurrent).length);

onMounted(loadSessions);

async function loadSessions() {
  loading.value = true;
  try {
    const response = await callAdminForthApi({ method: 'GET', path: '/plugin/user-sessions/list' });
    if (response) sessions.value = response.sessions;
  } finally {
    loading.value = false;
  }
}

async function revoke(session: UserSession) {
  const confirmed = await adminforth.confirm({
    message: t('Revoke session from {ip}? That browser will be signed out.', { ip: session.ip || t('unknown IP') }),
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
      body: { sessionId: session.sessionId },
    });
    await loadSessions();
  } finally {
    revokingId.value = null;
  }
}

async function revokeOthers() {
  const confirmed = await adminforth.confirm({
    message: t('Revoke all other sessions? Every browser except this one will be signed out.'),
    yes: t('Revoke all'),
    no: t('Cancel'),
    dangerous: true,
  });
  if (!confirmed) return;

  revokingAll.value = true;
  try {
    const response = await callAdminForthApi({ method: 'POST', path: '/plugin/user-sessions/revoke-others' });
    if (response) {
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
