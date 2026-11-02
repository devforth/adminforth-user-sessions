<template>
  <div class="af-revoke-session-page flex min-h-screen w-full items-center justify-center bg-lightHtml p-4 dark:bg-darkHtml">
    <Spinner v-if="state === 'loading'" class="w-8 h-8" />

    <DialogPanel
      v-else
      class="af-revoke-session-card"
      :title="header.title"
      :subtitle="header.subtitle"
      :error="error"
      :classes="state === 'active' ? {} : HEADER_ONLY_CLASSES"
    >
      <template #icon>
        <component :is="header.icon" />
      </template>

      <template v-if="state === 'active' && session">
        <dl class="af-revoke-session-details grid grid-cols-[88px_1fr] gap-x-4 gap-y-3 text-sm">
          <dt class="text-[13px] leading-5 text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('When') }}</dt>
          <dd class="text-lightShowTableBodyText dark:text-darkShowTableBodyText">{{ formatDateTime(session.created_at) }}</dd>

          <dt class="text-[13px] leading-5 text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('Device') }}</dt>
          <dd class="flex items-center gap-2 text-lightShowTableBodyText dark:text-darkShowTableBodyText">
            <component :is="DEVICE_ICONS[session.device?.type ?? 'unknown']" class="w-4 h-4 shrink-0 text-lightInputIconColor dark:text-darkInputIconColor" />
            {{ deviceLabel(session.device) }}
          </dd>

          <dt class="text-[13px] leading-5 text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('IP address') }}</dt>
          <dd class="text-lightShowTableBodyText dark:text-darkShowTableBodyText">{{ session.ip ?? $t('Unknown') }}</dd>

          <dt class="text-[13px] leading-5 text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('Location') }}</dt>
          <dd class="flex items-center gap-2 text-lightShowTableBodyText dark:text-darkShowTableBodyText">
            <CountryFlag v-if="session.country" :countryCode="session.country" />
            {{ session.country ? countryName(session.country) : $t('Unknown') }}
          </dd>
        </dl>
        <p class="text-sm text-lightInputIconColor dark:text-darkInputIconColor">
          {{ $t('If this was you, you can close this page.') }}
        </p>
      </template>

      <template v-if="state === 'active'" #footer>
        <Button
          class="mx-auto"
          variant="danger"
          :loader="inProgress"
          :disabled="inProgress"
          @click="revoke"
        >
          {{ $t('This wasn\'t me, end this session') }}
        </Button>
      </template>
    </DialogPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IconCircleCheck,
  IconCircleQuestionMark,
  IconLink2Off,
  IconMonitor,
  IconShieldAlert,
  IconSmartphone,
  IconTablet,
} from '@iconify-prerendered/vue-lucide';
import { Button, CountryFlag, DialogPanel, Spinner } from '@/afcl';
import { callAdminForthApi, formatDateTime } from '@/utils';

type SessionDevice = {
  browser: string | null;
  os: string | null;
  type: 'desktop' | 'mobile' | 'tablet';
};

type ReportedSession = {
  ip: string | null;
  country: string | null;
  device: SessionDevice | null;
  created_at: string;
};

// `ended`: the session expired or was ended before the link was opened
type PageState = 'loading' | 'invalid' | 'active' | 'ended' | 'revoked';

// states other than `active` say everything in the header, an empty body would leave a blank band under it
const HEADER_ONLY_CLASSES = { header: 'border-b-0', body: 'hidden' };

const DEVICE_ICONS = {
  desktop: IconMonitor,
  mobile: IconSmartphone,
  tablet: IconTablet,
  unknown: IconCircleQuestionMark,
};

const route = useRoute();
const { t, locale } = useI18n();

const state = ref<PageState>('loading');
const session = ref<ReportedSession | null>(null);
const inProgress = ref(false);
const error = ref<string | null>(null);

const header = computed(() => ({
  invalid: {
    icon: IconLink2Off,
    title: t('This link is invalid or has expired'),
    subtitle: t('If you do not recognize a recent sign-in, change your password.'),
  },
  active: {
    icon: IconShieldAlert,
    title: t('New sign-in to your account'),
    subtitle: t('Check the details below. Was this you?'),
  },
  ended: {
    icon: IconShieldAlert,
    title: t('This session has already ended'),
    subtitle: t('The device is signed out, the session expired or was ended earlier.'),
  },
  revoked: {
    icon: IconCircleCheck,
    title: t('Session ended'),
    subtitle: t('That device has been signed out.'),
  },
}[state.value as Exclude<PageState, 'loading'>]));

const DEVICE_TYPE_LABELS = computed(() => ({
  desktop: t('Desktop'),
  mobile: t('Mobile'),
  tablet: t('Tablet'),
}));

/**
 * `Chrome 131 on Linux · Desktop`, or whichever part of it the user agent told.
 */
function deviceLabel(device: SessionDevice | null): string {
  if (!device) {
    return t('Unknown device');
  }
  const name = device.browser && device.os
    ? t('{browser} on {os}', { browser: device.browser, os: device.os })
    : device.browser ?? device.os;
  return name ? `${name} · ${DEVICE_TYPE_LABELS.value[device.type]}` : DEVICE_TYPE_LABELS.value[device.type];
}

function countryName(code: string): string {
  return new Intl.DisplayNames([locale.value], { type: 'region' }).of(code) ?? code;
}

onMounted(async () => {
  const response = await callAdminForthApi({
    method: 'POST',
    path: '/plugin/user-sessions/session-by-token',
    body: { token: route.query.token },
  });
  if (!response || response.error) {
    state.value = 'invalid';
    return;
  }
  session.value = response.session;
  state.value = response.session ? 'active' : 'ended';
});

async function revoke() {
  error.value = null;
  inProgress.value = true;
  try {
    const response = await callAdminForthApi({
      method: 'POST',
      path: '/plugin/user-sessions/revoke-by-token',
      body: { token: route.query.token },
    });
    if (response?.ok) {
      state.value = 'revoked';
    } else if (response?.error) {
      error.value = t(response.error);
    }
  } finally {
    inProgress.value = false;
  }
}
</script>
