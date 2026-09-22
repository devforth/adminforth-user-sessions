<template>
  <div class="mt-6">
    <SessionsTable :userPk="userPk">
      <template #heading>
        <div>
          <h3 class="text-xl font-semibold leading-none text-gray-800 dark:text-gray-50">
            {{ $t('Active sessions') }}
          </h3>
          <p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
            {{ $t('Browsers this user is signed in from.') }}
          </p>
        </div>
      </template>
    </SessionsTable>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import SessionsTable from './SessionsTable.vue';

const props = defineProps<{
  record: Record<string, any>;
  meta: { primaryKeyField: string };
}>();

const userPk = computed(() => String(props.record[props.meta.primaryKeyField]));
</script>
