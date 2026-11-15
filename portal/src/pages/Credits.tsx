import { useState, type FormEvent } from 'react';
import { Coins, Plus, RotateCcw, Wallet } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';
import {
  Button, Card, EmptyState, ErrorState, Input, Modal, PageHeader, Select, Spinner,
  StatCard, Table, Textarea, useToast,
} from '../components/ui';

interface Balance { allocated: number; consumed: number; remaining: number }
interface Transaction {
  id: string;
  transaction_type: string;
  amount: number;
  notes: string | null;
  balance_before: number | null;
  balance_after: number | null;
  created_at: string;
  course_title?: string | null;
  student_name?: string | null;
  doctor_id?: string;
}
interface Doctor { id: string; full_name: string; email: string }

export default function Credits() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const { notify } = useToast();
  const isDoctor = user?.role === 'doctor';
  const [modal, setModal] = useState<'allocate' | 'refund' | null>(null);
  const [form, setForm] = useState({ doctor_id: '', amount: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentTitle(t('credits.title'));

  const { data, loading, error, reload } = useAsync(async (signal) => {
    if (isDoctor) {
      const [balance, ledger] = await Promise.all([
        api.get<Balance>('/credits/me', undefined, signal),
        api.get<{ transactions: Transaction[] }>('/credits/transactions', undefined, signal),
      ]);
      return { balance, transactions: ledger.transactions ?? [], doctors: [] as Doctor[] };
    }
    const [ledger, doctors] = await Promise.all([
      api.get<Transaction[]>('/api/credit_transactions', { order: 'created_at.desc', limit: 200 }, signal).catch(() => []),
      api.get<{ users: Doctor[] }>('/admin/users', { role: 'doctor', limit: 500 }, signal).catch(() => ({ users: [] })),
    ]);
    return {
      balance: null,
      transactions: Array.isArray(ledger) ? ledger : [],
      doctors: doctors.users ?? [],
    };
  }, [isDoctor]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.doctor_id || !form.amount) {
      setFormError('Doctor and amount are required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await api.post(modal === 'refund' ? '/credits/refund' : '/credits/allocate', {
        doctor_id: form.doctor_id,
        amount: Number(form.amount),
        notes: form.notes,
      });
      notify(t('common.success'));
      setModal(null);
      setForm({ doctor_id: '', amount: '', notes: '' });
      reload();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState />;

  return (
    <>
      <PageHeader
        title={t('credits.title')}
        subtitle={t('credits.subtitle')}
        actions={!isDoctor ? (
          <>
            <Button icon={<Plus size={16} />} onClick={() => { setForm({ doctor_id: '', amount: '', notes: '' }); setModal('allocate'); }}>{t('credits.allocate')}</Button>
            <Button icon={<RotateCcw size={16} />} onClick={() => { setForm({ doctor_id: '', amount: '', notes: '' }); setModal('refund'); }}>{t('credits.refund')}</Button>
          </>
        ) : undefined}
      />

      {data.balance && (
        <div className="stats-grid three">
          <StatCard label={t('credits.allocated')} value={formatNumber(data.balance.allocated, lang)} icon={<Coins size={20} />} tone="violet" />
          <StatCard label={t('credits.consumed')} value={formatNumber(data.balance.consumed, lang)} icon={<Wallet size={20} />} tone="amber" />
          <StatCard label={t('credits.balance')} value={formatNumber(data.balance.remaining, lang)} icon={<Wallet size={20} />} tone="green" />
        </div>
      )}

      <Card padded={false}>
        <div className="card-head padded-head"><h2>{t('credits.transactions')}</h2></div>
        {data.transactions.length === 0 ? <EmptyState /> : (
          <Table>
            <thead>
              <tr>
                <th>Type</th>
                {!isDoctor && <th>{t('credits.doctor')}</th>}
                <th>{t('credits.amount')}</th>
                <th>{t('credits.balance')}</th>
                <th>{t('credits.notes')}</th>
                <th>{t('audit.when')}</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td><span className="code">{transaction.transaction_type}</span></td>
                  {!isDoctor && <td className="mono small">{transaction.doctor_id?.slice(0, 8) ?? '—'}</td>}
                  <td className={transaction.amount < 0 ? 'negative' : 'positive'}>{formatNumber(transaction.amount, lang)}</td>
                  <td>{transaction.balance_after === null ? '—' : formatNumber(transaction.balance_after, lang)}</td>
                  <td>{transaction.notes ?? transaction.course_title ?? transaction.student_name ?? '—'}</td>
                  <td>{formatDate(transaction.created_at, lang, true)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        title={modal === 'refund' ? t('credits.refund') : t('credits.allocate')}
        footer={(
          <>
            <Button onClick={() => setModal(null)} disabled={saving}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" form="credit-form" loading={saving}>{t('common.confirm')}</Button>
          </>
        )}
      >
        <form id="credit-form" onSubmit={submit} className="stack">
          <Select label={t('credits.doctor')} required value={form.doctor_id} onChange={(e) => setForm({ ...form, doctor_id: e.target.value })}>
            <option value="">—</option>
            {data.doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.full_name} · {doctor.email}</option>)}
          </Select>
          <Input label={t('credits.amount')} type="number" min={1} required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <Textarea label={t('credits.notes')} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {formError && <div className="inline-error">{formError}</div>}
        </form>
      </Modal>
    </>
  );
}
