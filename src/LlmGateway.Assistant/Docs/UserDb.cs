using System.Text.Json;
using Npgsql;

namespace LlmGateway.Assistant.Docs;

// Runs work in a transaction as the signed-in user: `set local role authenticated` plus the
// user's id in request.jwt.claims, so RLS and auth.uid() apply exactly as for the Supabase client.
// Used for user-facing document data instead of the RLS-bypassing service-role access elsewhere.
public class UserDb
{
    private readonly NpgsqlDataSource _dataSource;

    public UserDb(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource;
    }

    // pgvector's text format: [0.1,0.2,...]. Avoids needing an extra Npgsql plugin package.
    public static string VectorLiteral(float[] values) =>
        "[" + string.Join(",", values.Select(v => v.ToString("G9", System.Globalization.CultureInfo.InvariantCulture))) + "]";

    public async Task<T> RunAsync<T>(Guid userId, Func<NpgsqlConnection, Task<T>> work, CancellationToken cancellationToken = default)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var role = new NpgsqlCommand("set local role authenticated", connection, transaction))
        {
            await role.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var claims = new NpgsqlCommand("select set_config('request.jwt.claims', $1, true)", connection, transaction))
        {
            claims.Parameters.AddWithValue(JsonSerializer.Serialize(new { sub = userId, role = "authenticated" }));
            await claims.ExecuteNonQueryAsync(cancellationToken);
        }

        var result = await work(connection);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }
}
